const express = require('express');
const { OpenAI } = require('openai');
const cors = require('cors');
const { connect } = require('@lancedb/lancedb');
const { OpenAIEmbeddings } = require('@langchain/openai');
const fileUpload = require('express-fileupload');
const pdf = require('pdf-parse'); // Ensure this is required
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '50mb' })); 
app.use(cors());
app.use(express.static(__dirname));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const embeddings = new OpenAIEmbeddings();

const DB_PATH = "s3://be-advocates-legal-data/lancedb";
const SESSION_TABLE = 'session_context';
const STATUTE_TABLE = 'nc_statutes';

const chapterMap = {
    "20": "Motor Vehicles Traffic Speeding Ticket Driving License",
    "42": "Landlord Tenant Rent Eviction Lease Repairs",
    "50": "Divorce Alimony Family Child Support Custody",
    "1A": "Civil Procedure Summons Debt Lawsuit Default",
    "122C": "Mental Health"
};

app.use(fileUpload());

/**
 * 1. TRAINING & CLEAR SESSION ENDPOINTS (Keeping your existing logic)
 */
app.post('/api/train', async (req, res) => {
    try {
        const { text, sourceName } = req.body;
        const db = await connect(DB_PATH);
        const vector = await embeddings.embedQuery(text);
        let table;
        try { table = await db.openTable(SESSION_TABLE); } 
        catch (e) { table = await db.createTable(SESSION_TABLE, [{ vector, text, source: sourceName }]); return res.json({ success: true }); }
        await table.add([{ vector, text, source: sourceName }]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: "Training failed." }); }
});

app.post('/api/clear-session', async (req, res) => {
    try {
        const db = await connect(DB_PATH);
        await db.dropTable(SESSION_TABLE).catch(() => {}); 
        res.json({ success: true });
    } catch (e) { res.json({ success: true }); }
});

/**
 * 2. MAIN CHAT: Hybrid Ingestion and Single-Pass S3 Search
 */
app.post('/api/chat', async (req, res) => {
    try {
        const { message, image, mimeType } = req.body; 
        let extractedText = "";

        // Step A: Multi-Format Ingestion
        if (image) {
            if (mimeType === 'text/plain') {
                extractedText = Buffer.from(image, 'base64').toString('utf-8');
            } 
            else if (mimeType === 'application/pdf') {
                const buffer = Buffer.from(image, 'base64');
                const pdfData = await pdf(buffer);
                extractedText = pdfData.text;
            } 
            else if (mimeType && mimeType.startsWith('image/')) {
                const visionResponse = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [{
                        role: "user",
                        content: [
                            { type: "text", text: "Extract legal issue and NCGS statute numbers." },
                            { type: "image_url", image_url: { url: `data:${mimeType};base64,${image}` } }
                        ],
                    }],
                });
                extractedText = visionResponse.choices[0].message.content;
            }
        }

        // Step B: Build Hybrid Query
        let hybridQuery = `DOCUMENT CONTENT: ${extractedText} \n\nUSER QUESTION: ${message || "Analyze this."}`;

        // Step C: Chapter Locking
        let detectedChapter = "";
        const scanText = hybridQuery.toLowerCase();
        for (const [num, keywords] of Object.entries(chapterMap)) {
            if (keywords.toLowerCase().split(' ').some(word => scanText.includes(word))) {
                detectedChapter = num;
                break;
            }
        }

        // Step D: Final "Boosted" Query for Vector Search
        const finalSearchString = detectedChapter ? `NCGS Chapter ${detectedChapter} ${hybridQuery}` : hybridQuery;
        
        // Step E: Single S3 Connection & Search
        const db = await connect(DB_PATH);
        const queryVector = await embeddings.embedQuery(finalSearchString);
        
        const statuteTable = await db.openTable(STATUTE_TABLE);
        const statuteResults = await statuteTable.search(queryVector).limit(15).toArray();

        let sessionResults = [];
        try {
            const sessionTable = await db.openTable(SESSION_TABLE);
            sessionResults = await sessionTable.search(queryVector).limit(3).toArray();
        } catch (e) {}

        // Step F: Format Context
        let retrievedContext = detectedChapter ? `*** PRIMARY LEGAL FOCUS: NCGS CHAPTER ${detectedChapter} ***\n` : "";
        statuteResults.forEach(r => retrievedContext += `[Source: ${r.source}]\n${r.text}\n\n`);
        if (sessionResults.length > 0) {
            retrievedContext += "--- USER PERSONAL DOCUMENTS ---\n";
            sessionResults.forEach(r => retrievedContext += `[Doc: ${r.source}]\n${r.text}\n`);
        }

        let context = statuteResults.map(r => `[Source: ${r.source}]\n${r.text}`).join('\n\n');

// Step 2: The Tightened Prompt
const systemPrompt = `
You are the B&E Solutions Navigator for Greensboro. 
Analyze the USER MESSAGE against the provided NC STATUTE CONTEXT.

CONTEXT FROM 57,407 NCGS CHUNKS:
${context}

OPERATIONAL DIRECTIVES:
1. DEFINITION MODE: If the user asks for a general definition (e.g., "What is a speeding ticket?"), provide a clear explanation first, then cite the relevant NCGS Chapter found in the context (usually Chapter 20 for traffic).
2. CASE ANALYSIS MODE: If a document is uploaded, cross-reference it with the context to find specific deadlines or penalties.
3. THE INDEPENDENT OBLIGATION RULE: Always emphasize that under NC law, most obligations are independent (e.g., you cannot withhold rent for lack of repairs without a court order).
4. MANDATORY WARNING: You MUST warn that ignoring legal notices leads to a "Default Judgment" (NCGS § 1A-1).
5. NO CONVERSATIONAL FILLER: Do not say "I understand" or "As an AI." Be a direct Navigator.

RETURN JSON: { "summary": "", "source": "NCGS Chapter ${detectedChapter || 'General'}", "deadline": "", "task": "", "urgency": "", "advice": "", "draft": "" }
`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: hybridQuery }],
            response_format: { "type": "json_object" }
        });

        res.json({ reply: JSON.parse(completion.choices[0].message.content) });

    } catch (error) {
        console.error("Critical Error:", error);
        res.status(500).json({ error: "The Navigator is currently offline." });
    }
});

const PORT = process.env.PORT || 3001; // Use Render's port or default to 3001 locally
app.listen(PORT, () => console.log(`🛡️ Navigator active on port ${PORT}`));
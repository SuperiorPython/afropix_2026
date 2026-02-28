const express = require('express');
const { OpenAI } = require('openai');
const cors = require('cors');
const { connect } = require('@lancedb/lancedb');
const { OpenAIEmbeddings } = require('@langchain/openai');
const fileUpload = require('express-fileupload');
const pdf = require('pdf-parse'); 
require('dotenv').config();

const app = express();

// --- 1. MIDDLEWARE (CORS MUST BE FIRST) ---
app.use(cors({
    origin: '*', // Allows Netlify to communicate with Render
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('/:splat*', cors()); // Explicitly handle preflight requests

app.use(express.json({ limit: '50mb' })); 
app.use(express.static(__dirname));
app.use(fileUpload());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const embeddings = new OpenAIEmbeddings();

// --- 2. CLOUD CONFIGURATION ---
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

/**
 * 3. SESSION MANAGEMENT
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
 * 4. CORE NAVIGATOR ENGINE (Hybrid Search)
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

        // Step C: Chapter Locking Logic
        let detectedChapter = "";
        const scanText = hybridQuery.toLowerCase();
        for (const [num, keywords] of Object.entries(chapterMap)) {
            if (keywords.toLowerCase().split(' ').some(word => scanText.includes(word))) {
                detectedChapter = num;
                break;
            }
        }

        // Step D: Vector Search on S3
        const finalSearchString = detectedChapter ? `NCGS Chapter ${detectedChapter} ${hybridQuery}` : hybridQuery;
        const db = await connect(DB_PATH);
        const queryVector = await embeddings.embedQuery(finalSearchString);
        
        const statuteTable = await db.openTable(STATUTE_TABLE);
        const statuteResults = await statuteTable.search(queryVector).limit(15).toArray();

        let sessionResults = [];
        try {
            const sessionTable = await db.openTable(SESSION_TABLE);
            sessionResults = await sessionTable.search(queryVector).limit(3).toArray();
        } catch (e) {}

        // Step E: Context Assembly
        let retrievedContext = detectedChapter ? `*** PRIMARY LEGAL FOCUS: NCGS CHAPTER ${detectedChapter} ***\n` : "";
        statuteResults.forEach(r => retrievedContext += `[Source: ${r.source}]\n${r.text}\n\n`);
        
        if (sessionResults.length > 0) {
            retrievedContext += "--- USER PERSONAL DOCUMENTS ---\n";
            sessionResults.forEach(r => retrievedContext += `[Doc: ${r.source}]\n${r.text}\n`);
        }

        // Step F: Tightened AI Response
        const systemPrompt = `
You are the B&E Solutions Navigator for Greensboro. 
Analyze the USER MESSAGE against the provided NC STATUTE CONTEXT.

CONTEXT FROM 57,407 NCGS CHUNKS:
${retrievedContext}

OPERATIONAL DIRECTIVES:
1. DEFINITION MODE: Provide a clear explanation first, then cite the relevant NCGS Chapter.
2. INDEPENDENT OBLIGATION RULE: Emphasize that rent and repairs are independent obligations in NC.
3. MANDATORY WARNING: Warn that ignoring legal notices leads to a "Default Judgment" (NCGS § 1A-1).
4. NO CONVERSATIONAL FILLER: Be a direct Navigator.

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

// --- 5. START SERVER ---
const PORT = process.env.PORT || 3001; 
app.listen(PORT, () => console.log(`🛡️ Navigator active on port ${PORT}`));


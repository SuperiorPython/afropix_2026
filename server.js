const express = require('express');
const { OpenAI } = require('openai');
const cors = require('cors');
const { connect } = require('@lancedb/lancedb');
const { OpenAIEmbeddings } = require('@langchain/openai');
const fileUpload = require('express-fileupload');
const pdf = require('pdf-parse'); 
require('dotenv').config();

const app = express();

// --- 1. GLOBAL INSTANCES (Persistent Connections) ---
let db;
let statuteTable;

// --- 2. MIDDLEWARE (EXPRESS 5 COMPLIANT) ---
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('/*path', cors()); 

app.use(express.json({ limit: '50mb' })); 
app.use(express.static(__dirname));
app.use(fileUpload());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const embeddings = new OpenAIEmbeddings();

const DB_PATH = "s3://be-advocates-legal-data/lancedb";
const STATUTE_TABLE = 'nc_statutes';
const SESSION_TABLE = 'session_context';

/**
 * 3. INITIALIZATION ENGINE: Connects to S3 Once on Startup
 */
async function initializeLegalEngine() {
    try {
        console.log("🔗 Connecting to S3 Legal Database...");
        db = await connect(DB_PATH);
        statuteTable = await db.openTable(STATUTE_TABLE);
        console.log("🛡️ Legal Engine Primed: 57,407 Chunks Ready.");
    } catch (error) {
        console.error("❌ Failed to connect to S3:", error);
    }
}

initializeLegalEngine();

/**
 * 4. CORE NAVIGATOR ENGINE
 */
app.post('/api/chat', async (req, res) => {
    try {
        // Safety check if S3 connection dropped
        if (!statuteTable) await initializeLegalEngine();

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

        let hybridQuery = `DOCUMENT CONTENT: ${extractedText} \n\nUSER QUESTION: ${message || "Analyze this."}`;

        // Step B: Vector Search (Using the Global persistent table)
        const queryVector = await embeddings.embedQuery(hybridQuery);
        const statuteResults = await statuteTable.search(queryVector).limit(10).toArray();

        let context = statuteResults.map(r => `[Source: ${r.source}]\n${r.text}`).join('\n\n');

        const systemPrompt = `
        You are the B&E Solutions Navigator for Greensboro. 
        Analyze the USER MESSAGE against the provided NC STATUTE CONTEXT.
        ${context}
        1. Warn that ignoring notices leads to a "Default Judgment" (NCGS § 1A-1).
        RETURN JSON: { "summary": "", "source": "NCGS Chapter General", "deadline": "", "task": "", "urgency": "", "advice": "", "draft": "" }
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

const PORT = process.env.PORT || 3001; 
app.listen(PORT, () => console.log(`🛡️ Navigator active on port ${PORT}`));


const express = require('express');
const { OpenAI } = require('openai');
const cors = require('cors');
const { connect } = require('@lancedb/lancedb');
const { OpenAIEmbeddings } = require('@langchain/openai');
const fileUpload = require('express-fileupload');
const pdf = require('pdf-parse'); 
require('dotenv').config();

const app = express();

// --- 1. GLOBAL POOL (Prevents 512MB OOM) ---
let db;
let statuteTable;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('(.*)', cors());
app.use(express.json({ limit: '10mb' })); // Lowered limit to save RAM
app.use(fileUpload());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const embeddings = new OpenAIEmbeddings();

const DB_PATH = "s3://be-advocates-legal-data/lancedb";
const STATUTE_TABLE = 'nc_statutes';

/**
 * 2. SINGLETON STARTUP: Run this ONCE
 */
async function startLegalEngine() {
    try {
        console.log("🔗 Connecting to S3...");
        db = await connect(DB_PATH);
        statuteTable = await db.openTable(STATUTE_TABLE);
        console.log("🛡️ Engine Live: 512MB RAM Stabilized.");
    } catch (e) { console.error("S3 Connection Failed", e); }
}
startLegalEngine();

app.post('/api/chat', async (req, res) => {
    try {
        if (!statuteTable) await startLegalEngine(); // Fallback

        const { message, image, mimeType } = req.body;
        let extractedText = "";

        // Ingestion logic (Keep as is)
        if (image && mimeType === 'application/pdf') {
            const pdfData = await pdf(Buffer.from(image, 'base64'));
            extractedText = pdfData.text;
        }

        const queryVector = await embeddings.embedQuery(message + extractedText);
        
        // REUSE GLOBAL TABLE (No new connection = No crash)
        const statuteResults = await statuteTable.search(queryVector).limit(5).toArray(); 

        const context = statuteResults.map(r => `[Source: ${r.source}]\n${r.text}`).join('\n\n');
        
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: `You are the Navigator. Use context: ${context}` },
                { role: "user", content: message }
            ],
            response_format: { "type": "json_object" }
        });

        res.json({ reply: JSON.parse(completion.choices[0].message.content) });
    } catch (error) {
        res.status(500).json({ error: "Navigator OOM - Restarting" });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🛡️ Port ${PORT} active`));

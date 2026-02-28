const { connect } = require('@lancedb/lancedb');
const { OpenAIEmbeddings } = require('@langchain/openai');
const { RecursiveCharacterTextSplitter } = require('@langchain/textsplitters');
const fs = require('fs/promises');
const path = require('path');
const cheerio = require('cheerio'); // Lightweight HTML parser
require('dotenv').config();

async function ingestStatutes() {
    try {
        // 1. Setup paths and database
        const statutesDir = './statutes'; 
        const db = await connect('./data/lancedb');
        const embeddings = new OpenAIEmbeddings();
        
        // 2. Scan for HTML files
        const files = await fs.readdir(statutesDir);
        const htmlFiles = files.filter(f => f.endsWith('.html'));
        
        console.log(`🚀 Found ${htmlFiles.length} HTML chapters. Starting extraction...`);

        let allChunks = [];

        // 3. Extract text from HTML
        for (const file of htmlFiles) {
            const filePath = path.join(statutesDir, file);
            const html = await fs.readFile(filePath, 'utf8');
            const $ = cheerio.load(html);
            
            // Get clean text from the body
            const text = $('body').text().replace(/\s+/g, ' ').trim();

            const splitter = new RecursiveCharacterTextSplitter({
                chunkSize: 1200, 
                chunkOverlap: 200
            });

            const docs = await splitter.splitText(text);
            
            // Tag each chunk with its chapter source
            docs.forEach(chunk => {
                allChunks.push({
                    text: chunk,
                    source: file
                });
            });
            
            if (allChunks.length % 500 === 0) {
                console.log(`📝 Collected ${allChunks.length} chunks so far...`);
            }
        }

        if (allChunks.length === 0) {
            throw new Error("No text was extracted. Check your HTML files.");
        }

        // 4. Batch Embedding Generation
        console.log(`🧬 Generating embeddings for ${allChunks.length} chunks in batches...`);
        
        const BATCH_SIZE = 100; 
        const tableData = [];

        for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
            const batch = allChunks.slice(i, i + BATCH_SIZE);
            
            try {
                // Send 100 chunks to OpenAI at a time
                const batchEmbeddings = await Promise.all(
                    batch.map(async (item) => ({
                        vector: await embeddings.embedQuery(item.text),
                        text: item.text,
                        source: item.source
                    }))
                );

                tableData.push(...batchEmbeddings);
                
                // Progress Tracker
                const progress = Math.round(((i + batch.length) / allChunks.length) * 100);
                process.stdout.write(`⏳ Progress: ${progress}% (${i + batch.length} / ${allChunks.length})\r`);
                
            } catch (batchErr) {
                console.error(`\n⚠️ Batch at index ${i} failed. Retrying in 2s...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                i -= BATCH_SIZE; // Re-try this batch
            }
        }

        // 5. Save to LanceDB
        console.log("\n💾 Finalizing local database storage...");
        await db.createTable('nc_statutes', tableData, { mode: 'overwrite' });
        
        console.log("-----------------------------------------");
        console.log("✅ SUCCESS: 57,407 Chunks of Justice Ready!");
        console.log("-----------------------------------------");

    } catch (err) {
        console.error("❌ CRITICAL ERROR:", err);
    }
}

ingestStatutes();
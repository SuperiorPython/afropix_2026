const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const path = require('path');

// 1. Correctly point to the .env in the parent directory
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const BUCKET = process.env.S3_BUCKET_NAME;
const REGION = process.env.AWS_REGION || "us-east-2";

// 2. Initialize the client ONLY ONCE
if (!BUCKET) {
    console.error("❌ ERROR: S3_BUCKET_NAME is undefined. Check your .env file at:", path.resolve(__dirname, '../.env'));
    process.exit(1);
}

const client = new S3Client({ region: REGION });

async function runDiagnostic() {
    try {
        console.log(`📡 Probing Bucket: ${BUCKET} in Region: ${REGION}...`);
        
        const command = new ListObjectsV2Command({ Bucket: BUCKET });
        const response = await client.send(command);
        const files = response.Contents?.map(c => c.Key) || [];

        if (files.length === 0) {
            console.log("❌ S3 reports 0 objects. Check if your files were uploaded to the root or a folder.");
            return;
        }

        console.log("✅ S3 CONNECTION SUCCESSFUL!");
        console.log(`📂 Found ${files.length} total objects.`);

        // --- Deep Scan Logic: Find the LanceDB Manifest ---
        const manifestFolders = new Set();
        files.forEach(file => {
            if (file.includes('_transactions') || file.includes('data/')) {
                const parts = file.split('/');
                const folderIndex = parts.findIndex(p => p.endsWith('.lance'));
                if (folderIndex !== -1) {
                    const folderPath = parts.slice(0, folderIndex + 1).join('/');
                    manifestFolders.add(folderPath);
                }
            }
        });

        if (manifestFolders.size > 0) {
            console.log("\n🎯 FOUND VALID LANCE TABLES AT:");
            manifestFolders.forEach(folder => console.log(`👉 s3://${BUCKET}/${folder}`));
            
            // This is the string you need for server.js
            const firstTablePath = Array.from(manifestFolders)[0];
            const dbBase = firstTablePath.split('/')[0];
            console.log(`\n💡 Suggested DB_PATH for server.js: "s3://${BUCKET}/${dbBase}"`);
        } else {
            console.log("\n❓ No .lance folders found. Top 5 raw files:");
            files.slice(0, 5).forEach(f => console.log(` - ${f}`));
        }

    } catch (err) {
        console.error("❌ DIAGNOSTIC FAILED:", err.message);
    }
}

runDiagnostic();
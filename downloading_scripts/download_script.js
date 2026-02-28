const axios = require('axios');
const fs = require('fs');
const path = require('path');

const downloadDir = path.join(__dirname, 'statutes'); // Saving to the folder shown in your explorer
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

async function downloadHtmlChapters() {
    const letters = ['', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    
    console.log("🚀 Starting HTML Statute Download...");

    for (let i = 1; i <= 170; i++) {
        for (const suffix of letters) {
            const ch = `${i}${suffix}`;
            const fileName = `Chapter_${ch}.html`;
            // Official NCGA HTML Path
            const url = `https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/ByChapter/${fileName}`;

            try {
                const response = await axios({ 
                    url, 
                    method: 'GET', 
                    timeout: 5000 
                });

                if (response.status === 200) {
                    const filePath = path.join(downloadDir, fileName);
                    fs.writeFileSync(filePath, response.data);
                    console.log(`✅ DOWNLOADED: ${fileName}`);
                }
            } catch (err) {
                // Skip 404s (chapters that don't exist)
                if (err.response?.status !== 404) {
                    console.log(`⚠️ Error on ${fileName}: ${err.message}`);
                }
            }
            
            // Short 100ms pause to be a "good citizen" to the NCGA server
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    console.log("🏁 HTML Download Complete!");
}

downloadHtmlChapters();
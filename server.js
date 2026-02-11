require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// نستخدم Gemini 1.5 Flash لأنه يمتلك نافذة سياق ضخمة (1 Million Tokens)
// هذا يسمح لنا بإرسال تفاصيل عشرات الأوراق البحثية دفعة واحدة للتحليل
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

app.use(express.json());
app.use(express.static('public'));
app.use(cors());

// --- 1. SEARCH API ---
app.get('/api/search', async (req, res) => {
    if (!req.query.q) return res.status(400).json({ error: "Query required" });
    try {
        const response = await axios.get(`https://api.semanticscholar.org/graph/v1/author/search`, {
            params: { query: req.query.q, limit: 15, fields: 'authorId,name,affiliations,hIndex,paperCount,citationCount' },
            headers: { 'x-api-key': process.env.S2_API_KEY || '' }
        });
        res.json(response.data.data || []);
    } catch (e) {
        res.status(500).json({ error: "Search Malfunction" });
    }
});

// --- 2. INTELLIGENCE ANALYSIS API (POST) ---
app.post('/api/analyze', async (req, res) => {
    const { authorId, userDescription } = req.body;
    
    if (!authorId) return res.status(400).send("Target ID Required");

    try {
        // 1. Fetch Deep Data (Up to 100 Papers)
        const resData = await axios.get(`https://api.semanticscholar.org/graph/v1/author/${authorId}`, {
            params: { 
                fields: 'name,affiliations,citationCount,hIndex,paperCount,url,papers.title,papers.year,papers.venue,papers.citationCount,papers.fieldsOfStudy,papers.authors,papers.url' 
            },
            headers: { 'x-api-key': process.env.S2_API_KEY || '' }
        });

        const author = resData.data;

        // 2. Pre-process Data for AI
        // نقوم بفرز الأوراق حسب الأهمية (الاستشهادات) وأخذ أهم 60 ورقة لتقليل الحمل مع الحفاظ على الدقة
        const keyPapers = author.papers
            .sort((a,b) => (b.citationCount || 0) - (a.citationCount || 0))
            .slice(0, 60)
            .map(p => `[${p.year}] "${p.title}" (Citations: ${p.citationCount}, Venue: ${p.venue}, Co-authors: ${p.authors?.map(a=>a.name).slice(0,2).join(', ')})`)
            .join('\n');

        // استخراج قائمة المتعاونين
        const collaborators = {};
        author.papers.forEach(p => {
            if(p.authors) p.authors.forEach(a => {
                if (a.authorId !== authorId && a.name) collaborators[a.name] = (collaborators[a.name] || 0) + 1;
            });
        });
        const topCollabs = Object.entries(collaborators).sort((a,b) => b[1]-a[1]).slice(0, 8);

        // 3. Construct the Intelligence Prompt
        let prompt = `
            Act as a Senior Scientific Intelligence Officer. 
            TARGET: ${author.name} (${author.affiliations?.[0] || 'Unknown'}).
            STATS: H-Index: ${author.hIndex}, Citations: ${author.citationCount}.
            DATA DUMP (Top 60 Papers):
            ${keyPapers}

            TASK 1: COMPREHENSIVE PROFILE
            - Analyze their career trajectory (Early vs. Current focus).
            - Identify their "Signature Contribution" to science.
            - Analyze their collaboration network (Who do they work with most?).
            
            TASK 2: RELEVANCE MATCHING
            User's Target Description/Field: "${userDescription || 'General Assessment (No specific field provided)'}".
            
            Based on the User's Description:
            - Calculate a "Match Score" (0 to 100) reflecting how well this researcher fits the description.
            - Provide a "Gap Analysis" (What is missing? or Why is it a perfect match?).
            
            OUTPUT FORMAT: JSON ONLY (No Markdown).
            {
                "full_report": "Write a detailed, 3-paragraph professional report. Use formatting like <b>Bold</b> for key terms. Paragraph 1: Career Arc. Paragraph 2: Technical Deep Dive. Paragraph 3: Impact & Network.",
                "match_score": 85,
                "match_reason": "One sentence explaining the score.",
                "key_technologies": ["Tech1", "Tech2", "Tech3", "Tech4", "Tech5"]
            }
        `;

        // 4. Execute AI
        const aiResult = await model.generateContent(prompt);
        const text = aiResult.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        const analysisData = JSON.parse(text);

        res.json({ author, analysis: analysisData, collaborators: topCollabs });

    } catch (e) {
        console.error("Analysis Error:", e.message);
        res.status(500).json({ error: "Intelligence System Failure" });
    }
});

app.listen(port, () => console.log(`[RADAR V3.0 ONLINE] http://localhost:${port}`));
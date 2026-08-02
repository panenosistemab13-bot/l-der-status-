import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));

// Gemini AI extraction endpoint
app.post("/api/extract", async (req, res) => {
  try {
    const { textoPlanilha } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: "GEMINI_API_KEY is not configured on the server." });
    }

    if (!textoPlanilha) {
      return res.status(400).json({ error: "textoPlanilha is required." });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ 
      model: "gemini-1.5-flash",
      systemInstruction: "Você é um extrator de dados estrito e especializado em planilhas. Sua tarefa é converter o texto copiado de planilhas (separado por tabulações ou vírgulas) em uma lista estruturada em JSON.\n\nREGRAS RÍGIDAS DE EXECUÇÃO:\n1. PROCESSAMENTO INTEGRAL: Você DEVE processar 100% das linhas do texto enviado. É estritamente proibido resumir, omitir linhas, cortar o texto no meio ou usar notações como \"... [linhas omitidas]\".\n2. FORMATO DA SAÍDA: Retorne EXCLUSIVAMENTE um array de objetos JSON válidos. Não inclua nenhuma introdução, explicação ou texto antes ou depois do JSON.\n3. ESTRUTURA DOS DADOS:\n   - Use os nomes das colunas da primeira linha como chaves (keys) de cada objeto.\n   - Se uma célula estiver vazia, defina seu valor como \"\" ou null.\n   - Mantenha números e datas no formato original enviado.\n4. INTEGRIDADE: Garanta que a quantidade de objetos no array final seja EXATAMENTE igual ao número de linhas de dados enviadas na planilha."
    });

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: `Abaixo estão os dados da planilha para converter:\n\n${textoPlanilha}` }] }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.1
      }
    });

    const responseText = result.response.text();
    const jsonData = JSON.parse(responseText);
    
    res.json(jsonData);
  } catch (error: any) {
    console.error("Extraction error:", error);
    res.status(500).json({ error: error.message || "Failed to extract data." });
  }
});

// Vite middleware setup
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

import express from 'express';
import bodyParser from 'body-parser';
import twilio from 'twilio';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json()); // For parsing application/json from Twilio (esp. in testing)

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_JSON);

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// Gemini config
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL_NAME = "gemini-1.5-flash-latest";

let genAI, model;
if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  model = genAI.getGenerativeModel({
    model: GEMINI_MODEL_NAME,
    systemInstruction: `
      You are a knowledgeable, friendly healthcare assistant.
      You help users understand health topics, explain medical concepts in clear terms, and provide general advice.
      You never diagnose or prescribe treatment.
      For symptom-related queries, give basic insights and recommend seeing a doctor.
      For general topics (like family planning), explain thoroughly but simply. Offer follow-up suggestions to help the user learn more.
    `,
    safetySettings: [
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
      { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    ],
    generationConfig: {
      temperature: 0.6,
      maxOutputTokens: 300,
    },
  });
} else {
  console.error("❌ Missing GEMINI_API_KEY");
}

app.post('/webhook', async (req, res) => {
  const incomingMsg = req.body.Body;
  const from = req.body.From;
  console.log(`📩 Message from ${from}: ${incomingMsg}`);

  if (!model) {
    const twimlError = new twilio.twiml.MessagingResponse();
    twimlError.message("Sorry, the AI assistant is not configured right now.");
    res.set('Content-Type', 'text/xml');
    return res.status(500).send(twimlError.toString());
  }

  try {
    const resetTriggers = ['reset', 'clear', 'start over'];
    if (resetTriggers.includes(incomingMsg.trim().toLowerCase())) {
      await db.collection('context').doc(from).delete();
      const twimlReset = new twilio.twiml.MessagingResponse();
      twimlReset.message("🧼 Context cleared. Let’s start fresh!");
      res.set('Content-Type', 'text/xml');
      return res.send(twimlReset.toString());
    }

    let contextData = { history: [] };
    const contextRef = db.collection('context').doc(from);
    const contextDoc = await contextRef.get();
    if (contextDoc.exists) contextData = contextDoc.data();

    contextData.history.push({ role: 'user', content: incomingMsg });
    if (contextData.history.length > 6) contextData.history = contextData.history.slice(-6);

    const reply = await getHealthReplyWithGeminiSDK(contextData.history);
    contextData.history.push({ role: 'assistant', content: reply });
    await contextRef.set(contextData, { merge: true });

    await db.collection('chats').add({
      from,
      message: incomingMsg,
      reply,
      timestamp: new Date(),
    });

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(`${reply}

⚠️ *Disclaimer: I am an AI assistant. This is not medical advice. Always consult a doctor.*`);
    res.set('Content-Type', 'text/xml');
    res.send(twiml.toString());
  } catch (error) {
    console.error('❌ Error:', error);
    let userMessage = "Sorry, I encountered an error. Please try again later.";
    if (error.message.includes('SAFETY')) {
      userMessage = "This topic may be sensitive. Please consult a healthcare provider.";
    }

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(userMessage);
    res.set('Content-Type', 'text/xml');
    res.status(500).send(twiml.toString());
  }
});

async function getHealthReplyWithGeminiSDK(history) {
  if (!model) throw new Error("Gemini model not initialized.");

  const prompt = history.map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`).join('\n');
  console.log(`⚙️ Gemini Prompt:\n${prompt.slice(0, 300)}...`);

  try {
    const result = await model.generateContent(prompt);
    const response = result.response;

    if (response?.promptFeedback?.blockReason) {
      console.warn(`⚠️ Blocked: ${response.promptFeedback.blockReason}`);
      return `I cannot respond due to safety guidelines. (${response.promptFeedback.blockReason})`;
    }

    return response.text().trim();
  } catch (err) {
    console.error("Gemini error:", err);
    throw err;
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

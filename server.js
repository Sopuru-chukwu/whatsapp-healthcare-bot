// server.js
import express from 'express';
import bodyParser from 'body-parser';
import twilio from 'twilio';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { createRequire } from 'module';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';

const require = createRequire(import.meta.url);
const serviceAccount = require('./firebase-service-account.json');

dotenv.config();

// Initialize Firebase
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Gemini API Configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL_NAME = "gemini-1.5-flash-latest";

// Initialize Google AI Client
let genAI;
let model;
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
  console.error("❌ FATAL: Missing GEMINI_API_KEY environment variable. Gemini functionality will be disabled.");
}

app.post('/webhook', async (req, res) => {
  const incomingMsg = req.body.Body;
  const from = req.body.From;
  console.log(`📩 Message from ${from}: ${incomingMsg}`);

  if (!model) {
    const twimlError = new twilio.twiml.MessagingResponse();
    twimlError.message("Sorry, my AI component is not configured correctly. I cannot process requests right now.");
    res.set('Content-Type', 'text/xml');
    return res.status(500).send(twimlError.toString());
  }

  try {
    const resetTriggers = ['reset', 'clear', 'start over'];
    if (resetTriggers.includes(incomingMsg.trim().toLowerCase())) {
      await db.collection('context').doc(from).delete();

      const twimlReset = new twilio.twiml.MessagingResponse();
      twimlReset.message("🧼 Your conversation context has been cleared. Let's start fresh!");
      res.set('Content-Type', 'text/xml');
      return res.send(twimlReset.toString());
    }

    let contextData = { history: [] };
    const contextRef = db.collection('context').doc(from);
    const contextDoc = await contextRef.get();

    if (contextDoc.exists) {
      contextData = contextDoc.data();
    }

    contextData.history.push({ role: 'user', content: incomingMsg });
    if (contextData.history.length > 6) contextData.history = contextData.history.slice(-6); // Keep last 6 messages

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

⚠️ *Disclaimer: I am an AI assistant. This information is not a substitute for professional medical advice. Always consult a qualified healthcare provider.*`);

    res.set('Content-Type', 'text/xml');
    res.send(twiml.toString());
  } catch (error) {
    console.error('❌ Error handling message:', error);
    let userMessage = "Sorry, I encountered an error while trying to generate a response. Please try again later.";
    if (error.message.includes('Response was blocked due to SAFETY')) {
      userMessage = "I cannot provide information on this topic due to safety guidelines. Please consult a healthcare professional.";
    } else if (error.message.includes('finishReason: SAFETY')) {
      userMessage = "My response was stopped due to safety guidelines. Please consult a healthcare professional.";
    }

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(userMessage);
    res.set('Content-Type', 'text/xml');
    res.status(500).send(twiml.toString());
  }
});

async function getHealthReplyWithGeminiSDK(conversationHistory) {
  if (!model) throw new Error("Gemini model is not initialized.");

  const prompt = conversationHistory.map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`).join('\n');

  console.log(`⚙️ Prompt to Gemini SDK:\n${prompt.slice(0, 300)}...`);

  try {
    const result = await model.generateContent(prompt);
    const response = result.response;

    if (response.promptFeedback?.blockReason) {
      console.warn(`⚠️ Blocked. Reason: ${response.promptFeedback.blockReason}`);
      return `I cannot process this request due to safety guidelines (${response.promptFeedback.blockReason}). Please consult a healthcare professional.`;
    }

    const text = response.text();
    console.log(`✅ Gemini response: ${text.slice(0, 100)}...`);
    return text.trim();
  } catch (error) {
    console.error('❌ Gemini SDK error:', error);
    if (error.message.includes('finishReason: SAFETY')) {
      throw new Error('Response generation stopped due to SAFETY');
    }
    throw new Error(`Failed to get reply from Gemini SDK: ${error.message}`);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 WhatsApp Healthcare Bot (Gemini SDK) running on port ${PORT}`);
});

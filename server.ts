import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import cors from "cors";
import helmet from "helmet";
import { GoogleGenAI } from "@google/genai";
import { Groq } from "groq-sdk";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(helmet({
  contentSecurityPolicy: false, // For development and preview
}));
app.use(express.json({ limit: '50mb' }));

// Setup Gemini (keeping as a high-quality fallback for messy handwriting as requested with "ember/others")
const ai = new GoogleGenAI({ 
  apiKey: process.env.GEMINI_API_KEY || "",
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

// Setup Groq
const GROQ_KEY = process.env.GROQ_API_KEY || "";
const groq = new Groq({
  apiKey: GROQ_KEY,
});

// Configure Multer for image uploads
const upload = multer({ storage: multer.memoryStorage() });

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Helper to parse JSON safely from LLM output
function parseJSONFromText(text: string): any {
  if (!text) return null;
  const cleaned = text.trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {}

  try {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
  } catch (err) {}

  try {
    let replaced = cleaned;
    if (replaced.startsWith("```json")) {
      replaced = replaced.substring(7);
    } else if (replaced.startsWith("```")) {
      replaced = replaced.substring(3);
    }
    if (replaced.endsWith("```")) {
      replaced = replaced.substring(0, replaced.length - 3);
    }
    return JSON.parse(replaced.trim());
  } catch (err) {}

  return null;
}

async function generateRiskAssessment(prescription: any) {
  if (!GROQ_KEY.trim()) return null;

  const completion = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "You provide cautious prescription safety education, not a diagnosis. Return JSON only. Do not tell the user to start, stop, or change a medicine. Escalate urgent symptoms to emergency care."
      },
      {
        role: "user",
        content: `Review this extracted prescription and return exactly: {"score": number from 0 to 100, "level": "Low" | "Moderate" | "High", "summary": "short plain-language safety note", "nextSteps": ["2 to 4 safe practical steps"], "redFlags": ["possible urgent warning signs"]}. Base the score only on uncertainty, possible interactions, dosing ambiguity, and need for professional review. Prescription: ${JSON.stringify(prescription)}`
      }
    ]
  });

  const parsed = parseJSONFromText(completion.choices[0]?.message?.content || "");
  if (!parsed) return null;
  return {
    score: Math.max(0, Math.min(100, Number(parsed.score) || 0)),
    level: ["Low", "Moderate", "High"].includes(parsed.level) ? parsed.level : "Moderate",
    summary: typeof parsed.summary === "string" ? parsed.summary : "Review this prescription with a pharmacist or clinician if anything is unclear.",
    nextSteps: Array.isArray(parsed.nextSteps) ? parsed.nextSteps.filter((step: unknown) => typeof step === "string") : [],
    redFlags: Array.isArray(parsed.redFlags) ? parsed.redFlags.filter((flag: unknown) => typeof flag === "string") : []
  };
}

// OCR & Analysis Endpoint
app.post("/api/analyze", upload.single('prescription'), async (req: express.Request, res: express.Response) => {
  try {
    if (!process.env.GEMINI_API_KEY?.trim() && !GROQ_KEY.trim()) {
      return res.status(503).json({
        error: "AI service is not configured. Add a valid GEMINI_API_KEY or GROQ_API_KEY to your .env file, then restart the server."
      });
    }

    const multerReq = req as any; // Cast for easier access to multer properties
    if (!multerReq.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const base64Image = multerReq.file.buffer.toString('base64');
    let mimetype = multerReq.file.mimetype || 'image/jpeg';
    if (mimetype === 'application/octet-stream' || !mimetype.startsWith('image/')) {
      mimetype = 'image/jpeg';
    }
    
    const prescriptionType = req.body.prescriptionType || 'scrambled';
    let extractedText = "";
    let extractionMethod = "";
    let lastError: Error | null = null;
    let result: any = null;
 
    console.log("--- Starting Prescription Extraction Pipeline ---");
    console.log(`Requested Type: ${prescriptionType}, Normalized Image Mime-Type: ${mimetype}, Buffer Size: ${multerReq.file.buffer.length} bytes`);
 
    // --- STRATEGY A: Direct Multimodal Structured JSON Extraction (Fast, Accurate, Context-Aware) ---
    // We run this directly for both types to ensure high-quality, fast parsing, but customize the prompt instruction.
    {
      // This utilizes Gemini and Llama Vision models to process handwriting directly into structured JSON.
      
      const prescriptionContextPrompt = prescriptionType === 'printed'
        ? "This is a clean, printed or neatly written medical prescription. Read it with extremely high literal word-for-word precision. Carefully extract all printed headings, table entries, and medication names."
        : "This is a messy, scrambled, or cursive handwritten medical prescription. Scan the handwriting, symbols, and standard medicine scribbles carefully and structure them.";

      // Candidate 1: Gemini Multimodal Vision direct extraction (highly advanced)
      // We prioritize gemini-3.1-flash-lite to bypass temporary 503 high demand on gemini-3.5-flash
      const directGeminiModels = ["gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-flash-latest", "gemini-3.1-pro-preview"];
      for (const modelName of directGeminiModels) {
        if (result) break;
        try {
          console.log(`Attempting Direct Multimodal extraction via Gemini Model: ${modelName}...`);
          const imagePart = {
            inlineData: {
              mimeType: mimetype,
              data: base64Image
            }
          };
          const textPart = {
            text: `You are an expert clinical pharmacist and professional medical prescription reader.
${prescriptionContextPrompt}
Scan the components in this medical prescription image and extract ALL details directly into structured JSON.

Instructions for fields:
1. "doctorName": Name of the doctor/prescriber, or clinical brand (e.g., 'Dr. Jane Smith'). Return 'Not found' if completely illegible.
2. "patientName": Name of the patient (e.g., 'John Doe'). Return 'Not found' if completely illegible.
3. "disease": Diagnosis, primary symptoms, complaints, or physical conditions treated. Return 'Not found' if completely illegible.
4. "date": Date of visit or script (e.g., '10/24/2026'). Return 'Not found' if completely illegible.
5. "rawOcrText": A literal transcription of every readable word, number, and medicine instruction in the image. Preserve uncertainty with [unclear].
6. "analysis": Detailed patient advisory, education, and usage consultation notes formatted cleanly in Markdown. Include clear dosage explanations, food requirements, potential side effects, and caution advisories.
7. "medications": Array of objects, each containing:
   - "name": Standard pharmaceutical or brand name of the tablet/capsule/syrup (string, e.g. "Amoxicillin")
   - "dosage": Strength or intake directions (string, e.g. "500mg, twice daily post meal")
7. "suggestedAlarms": Array of objects to automatically turn on alarms for the patient at the correct time based on the prescription description or instructions. Each object contains:
   - "title": Name of the medicine (e.g., "Paracetamol")
   - "time": Alarm time in 24-hour format "HH:MM" (e.g., "08:00", "14:00", "20:00"). If the instruction says morning/breakfast, suggest "08:00". If afternoon/lunch, suggest "14:00". If evening/night/dinner/bedtime, suggest "20:00". If a specific time is mentioned (e.g., "8.00pm"), use that exact time translated to 24-hour format (e.g., "20:00").

You MUST return a single, valid JSON object matching this exact schema:
{
  "doctorName": "string",
  "patientName": "string",
  "disease": "string",
  "date": "string",
  "rawOcrText": "literal OCR transcription",
  "analysis": "string in markdown",
  "medications": [
    { "name": "string", "dosage": "string" }
  ],
  "suggestedAlarms": [
    { "title": "string", "time": "string" }
  ]
}`
          };

          const visionResult = await ai.models.generateContent({
            model: modelName,
            contents: {
              parts: [imagePart, textPart]
            },
            config: {
              responseMimeType: "application/json"
            }
          });

          if (visionResult && visionResult.text) {
            const parsed = parseJSONFromText(visionResult.text);
            if (parsed && (parsed.doctorName || parsed.medications?.length > 0)) {
              // Guard against negative/fallback empty text "Not found" in all fields
              const isAllNotFound = 
                parsed.doctorName === "Not found" && 
                parsed.patientName === "Not found" && 
                parsed.disease === "Not found" &&
                (!parsed.medications || parsed.medications.length === 0);
              
              if (!isAllNotFound) {
                result = parsed;
                extractedText = typeof parsed.rawOcrText === "string" && parsed.rawOcrText.trim()
                  ? parsed.rawOcrText.trim()
                  : visionResult.text;
                extractionMethod = `Gemini Multimodal JSON (${modelName})`;
                console.log(`SUCCESS: Direct Multimodal JSON extracted via Gemini (${modelName})`);
                break;
              } else {
                console.warn(`Gemini Direct (${modelName}) returned blank 'Not found' fields, falling back to other pipeline routes...`);
              }
            }
          }
        } catch (geminiError: any) {
          console.log(`Note: Direct Multimodal Gemini ${modelName} was temporarily unavailable or busy. Trying next model...`);
          lastError = geminiError;
        }
      }

      // Candidate 2: Groq Llama-Vision direct extraction
      if (!result) {
        try {
          console.log("Attempting Direct Multimodal extraction via Groq Llama-Vision...");
          const groqVisionResult = await groq.chat.completions.create({
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `You are an expert clinical pharmacist and professional medical prescription reader.
${prescriptionContextPrompt}
Scan the components in this medical prescription image and extract ALL details directly into structured JSON.

You MUST return ONLY a single valid JSON object matching this schema (do NOT include any introductory speech or markdown wrappers):
{
  "doctorName": "Doctor/Prescriber name or 'Not found'",
  "patientName": "Patient name or 'Not found'",
  "disease": "Diagnosis or symptoms or 'Not found'",
  "date": "Prescription date or 'Not found'",
  "rawOcrText": "Literal OCR transcription of all readable text; use [unclear] for uncertain words",
  "analysis": "Detailed patient advisory/education guide in clean markdown format.",
  "medications": [
    { "name": "Name of medicine", "dosage": "Instructions or strength" }
  ],
  "suggestedAlarms": [
    { "title": "Name of medicine", "time": "Alarm time in 24-hour format 'HH:MM' (e.g. '08:00', '14:00', '20:00'). Deduce from dosage times." }
  ]
}`
                  },
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:${mimetype};base64,${base64Image}`
                    }
                  }
                ]
              }
            ],
            model: "llama-3.2-90b-vision-preview",
            response_format: { type: "json_object" }
          });

          const text = groqVisionResult.choices[0]?.message?.content;
          if (text) {
            const parsed = parseJSONFromText(text);
            if (parsed && (parsed.doctorName || parsed.medications?.length > 0)) {
              const isAllNotFound = 
                parsed.doctorName === "Not found" && 
                parsed.patientName === "Not found" && 
                parsed.disease === "Not found" &&
                (!parsed.medications || parsed.medications.length === 0);
                
              if (!isAllNotFound) {
                result = parsed;
                extractedText = typeof parsed.rawOcrText === "string" && parsed.rawOcrText.trim()
                  ? parsed.rawOcrText.trim()
                  : text;
                extractionMethod = "Groq Llama-Vision Direct JSON";
                console.log("SUCCESS: Direct Multimodal JSON extracted via Groq Llama-Vision.");
              }
            }
          }
        } catch (groqVisionError: any) {
          console.warn("Direct Groq Llama-Vision query failed:", groqVisionError.message || groqVisionError);
          lastError = groqVisionError;
        }
      }
    }

    // --- STRATEGY B: Two-Stage OCR and Text Analysis Fallback ---
    // If Direct Multimodal JSON extraction failed (or returned all 'Not found').
    if (!result) {
      console.log("--- Executing Two-Stage OCR Pipeline ---");

      // Stage B.1: Parse Raw text from Vision API
      // Try Gemini text extraction first
      const textGeminiModels = ["gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-flash-latest", "gemini-3.1-pro-preview"];
      for (const modelName of textGeminiModels) {
        try {
          console.log(`Attempting handwriting recognition via Gemini model: ${modelName}...`);
          const imagePart = {
            inlineData: {
              mimeType: mimetype,
              data: base64Image
            }
          };
          const textPart = {
            text: "This is a medical prescription. Please perform professional character recognition (OCR) and extract ALL readable printed and handwritten text: patient details, doctor details, date, medicine names, strengths (e.g., mg, ml), instructions (e.g., once daily, post-meal), and diagnostics."
          };

          const visionResult = await ai.models.generateContent({
            model: modelName,
            contents: {
              parts: [imagePart, textPart]
            }
          });

          if (visionResult && visionResult.text && visionResult.text.trim().length > 15) {
            extractedText = visionResult.text;
            extractionMethod = `Gemini Vision OCR (${modelName})`;
            console.log(`SUCCESS: Gemini Vision (${modelName}) extracted ${extractedText.length} characters.`);
            break;
          }
        } catch (geminiError: any) {
          console.log(`Note: Gemini Vision OCR model ${modelName} was busy or unavailable. Trying next OCR candidate...`);
          lastError = geminiError;
        }
      }

      // Try Groq Llama-Vision text extraction
      if (!extractedText) {
        try {
          console.log("No text extracted from Gemini OCR. Attempting handwriting recognition via Groq Llama-Vision...");
          const groqVisionResult = await groq.chat.completions.create({
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "This is a medical prescription. Please read and extract all readable text: medicines, dosage, instructions, doctor details, date."
                  },
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:${mimetype};base64,${base64Image}`
                    }
                  }
                ]
              }
            ],
            model: "llama-3.2-90b-vision-preview"
          });

          const text = groqVisionResult.choices[0]?.message?.content;
          if (text && text.trim().length > 15) {
            extractedText = text;
            extractionMethod = "Groq Llama-Vision OCR";
            console.log(`SUCCESS: Groq Llama-Vision OCR extracted ${extractedText.length} characters.`);
          }
        } catch (groqVisionError: any) {
          console.error("Groq Llama-Vision OCR fallback failed as well:", groqVisionError.message || groqVisionError);
          lastError = groqVisionError;
        }
      }

      // If we still have no text at all, throw
      if (!extractedText) {
        console.error("All extraction pipelines (Gemini, Groq) failed entirely.");
        const details = lastError ? ` Details: ${lastError.message || lastError}` : "";
        throw new Error(`Unable to extract text from the prescription image.${details} Please upload a clearer image, or double-check your API key configurations.`);
      }

      // Stage B.2: Parse structured JSON from extracted text
      try {
        console.log("Attempting structured NER analysis via Groq...");
        const nerCompletion = await groq.chat.completions.create({
          messages: [
            {
              role: "system",
              content: `You are an expert medical data extraction assistant.
              Extract structured data from the following OCR text of a medical prescription.
              Be extremely analytical: if doctors, patients, or details are present, capture them clearly.
              If they are missing or the text is highly scrambled, make an educated guess or mark 'Not found' for specific properties.`
            },
            {
              role: "user",
              content: `Extract structured fields and return a single valid JSON object.
              OCR Text to parse: ${extractedText}
              
              JSON Schema:
              {
                "doctorName": "Doctor name or 'Not found'",
                "patientName": "Patient name or 'Not found'",
                "disease": "Diagnosis or symptoms or 'Not found'",
                "date": "Date or 'Not found'",
                "analysis": "Markdown analysis explaining warnings, dosage frequency, and professional suggestions.",
                "medications": [
                  { "name": "Name", "dosage": "Instructions" }
                ],
                "suggestedAlarms": [
                  { "title": "Name", "time": "Alarm time in 24-hour format 'HH:MM' (e.g. '08:00', '14:00', '20:00'). Deduce from instructions." }
                ]
              }`
            }
          ],
          model: "llama-3.3-70b-versatile",
          response_format: { type: "json_object" }
        });

        const content = nerCompletion.choices[0]?.message?.content || "{}";
        result = parseJSONFromText(content);
      } catch (groqError: any) {
        console.warn("Groq NER failed, trying Gemini text NER fallback...", groqError);
        try {
          let geminiNer;
          for (const model of ["gemini-3.1-flash-lite", "gemini-3.5-flash"]) {
            try {
              geminiNer = await ai.models.generateContent({
                model,
                contents: `You are an expert medical data extraction assistant.
                Extract structured data from the following OCR text of a medical prescription.
                Return a single valid JSON object matching the keys: doctorName, patientName, disease, date, analysis (detailed markdown describing diagnosis, usage schedules, warnings, and consultation guidelines), medications (array of objects with keys "name" and "dosage"), suggestedAlarms (array of objects with keys "title" and "time" indicating 24-hour "HH:MM" alarm times deduced from description).
                
                OCR Text: ${extractedText}`,
                config: {
                  responseMimeType: "application/json"
                }
              });
              if (geminiNer && geminiNer.text) {
                break;
              }
            } catch (err: any) {
              console.log(`Note: Gemini fallback NER with model ${model} was busy or unavailable. Trying next...`);
            }
          }
          const content = geminiNer?.text || "{}";
          result = parseJSONFromText(content);
        } catch (geminiNerError: any) {
          console.error("Gemini fallback NER failed as well:", geminiNerError);
          result = {
            doctorName: "See Raw Extract",
            patientName: "See Raw Extract",
            disease: "Prescription Scan",
            date: new Date().toLocaleDateString(),
            analysis: "### Extracted Prescription Text\n\n" + extractedText + "\n\n*Note: Structured parsing was unavailable. Please read raw text.*",
            medications: []
          };
        }
      }
    }

    // Default ensure result properties are populated to avoid crashes
    if (!result) {
      result = {
        doctorName: "Not found",
        patientName: "Not found",
        disease: "Not found",
        date: "Not found",
        analysis: "### No text read\n\nWe couldn't extract readable text. Please verify the photo is bright and clear.",
        medications: []
      };
    }

    let riskAssessment = null;
    try {
      riskAssessment = await generateRiskAssessment(result);
    } catch (riskError: any) {
      console.warn("Groq risk assessment unavailable:", riskError.message || riskError);
    }

    res.json({
      ocrText: extractedText || "No raw text read (Direct Multimodal pipeline used)",
      extractionMethod,
      riskAssessment,
      ...result
    });
  } catch (error: any) {
    console.error("Analysis Error:", error);
    res.status(500).json({ error: error.message || "Failed to analyze prescription" });
  }
});

// Chatbot Endpoint
app.post("/api/chat", async (req, res) => {
  try {
    const { message, context, language } = req.body;
    let reply = "";
    
    try {
      console.log("Attempting chat completion via Groq...");
      const completion = await groq.chat.completions.create({
        messages: [
          {
            role: "system",
            content: `You are a helpful medical assistant chatbot. 
            The user has uploaded a prescription with the following context: ${context}.
            Answer the user's questions clearly based on this context. 
            
            LANGUAGE PREFERENCE:
            The user's preferred language is: ${language || 'both'}.
            - If "ta", you MUST answer ONLY in clear Tamil (using Tamil script, தமிழ்). E.g., "மாத்திரையை காலையில் உணவுக்கு பின் எடுத்துக்கொள்ளவும்."
            - If "en", you MUST answer ONLY in English.
            - If "both", you should answer in a friendly bilingual combination of English and Tamil (using mixed English/Tamil text or scripts) so it is simple and easy to understand.
            
            REMINDER SCHEDULING:
            If the user requests to set an alarm, reminder, or schedule a medication, detect the title (e.g. tablet name) and time requested. Append exactly this format at the end of your message: [SET_REMINDER: Title="...", Time="HH:MM"] (use AM/PM or HH:MM format).
            
            CRITICAL RULE: Keep your response extremely short, sweet, and concise (no more than 1 or 2 brief sentences, maximum 20 words). Never write long paragraphs.`
          },
          {
            role: "user",
            content: message
          }
        ],
        model: "llama-3.3-70b-versatile",
      });
      reply = completion.choices[0]?.message?.content || "";
    } catch (groqChatError: any) {
      console.warn("Groq chat failed, falling back to Gemini Chat:", groqChatError);
      
      try {
        let geminiChat;
        for (const model of ["gemini-3.1-flash-lite", "gemini-3.5-flash"]) {
          try {
            geminiChat = await ai.models.generateContent({
              model,
              contents: message,
              config: {
                systemInstruction: `You are a helpful medical assistant chatbot. 
                The user has uploaded a prescription with the following context: ${context}.
                Answer the user's questions clearly based on this context. 
                
                LANGUAGE PREFERENCE:
                The user's preferred language is: ${language || 'both'}.
                - If "ta", you MUST answer ONLY in clear Tamil (using Tamil script, தமிழ்).
                - If "en", you MUST answer ONLY in English.
                - If "both", you should answer in a friendly bilingual combination of English and Tamil (using mixed English/Tamil text or scripts) so it is simple and easy to understand.
                
                REMINDER SCHEDULING:
                If the user requests to set an alarm, reminder, or schedule a medication, detect the title (e.g. tablet name) and time requested. Append exactly this format at the end of your message: [SET_REMINDER: Title="...", Time="HH:MM"] (use AM/PM or HH:MM format).
                
                CRITICAL RULE: Keep your response extremely short, sweet, and concise (no more than 1 or 2 brief sentences, maximum 20 words). Never write long paragraphs.`
              }
            });
            if (geminiChat && geminiChat.text) {
              reply = geminiChat.text;
              break;
            }
          } catch (err: any) {
            console.log(`Note: Gemini chat fallback with model ${model} was busy or unavailable. Trying next...`);
          }
        }
        if (!reply) throw new Error("All Gemini chat fallbacks failed");
      } catch (geminiChatError: any) {
        console.error("Gemini chat fallback failed too:", geminiChatError);
        reply = "I'm experiencing custom API connectivity limits. I can help answer manual queries, or you can add active alarms on the left panel! [SET_REMINDER: Title=\"" + message.slice(0, 15) + "\", Time=\"08:00\"]";
      }
    }

    res.json({ reply });
  } catch (error: any) {
    console.error("Chat Error:", error);
    res.status(500).json({ error: error.message || "Chatbot error" });
  }
});

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

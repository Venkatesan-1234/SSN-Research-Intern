/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useEffect } from 'react';
import { 
  Upload, 
  Search, 
  FileText, 
  User, 
  Calendar, 
  Stethoscope, 
  MessageCircle, 
  Send, 
  ArrowRight, 
  CheckCircle2, 
  Loader2, 
  X,
  Plus,
  Volume2,
  VolumeX,
  Mic,
  MicOff,
  Bell,
  Clock,
  Trash2,
  Volume1,
  AlertCircle,
  Sparkles
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import Markdown from 'react-markdown';

interface AnalysisResult {
  ocrText: string;
  doctorName: string;
  patientName: string;
  disease: string;
  date: string;
  analysis: string;
  medications: (string | { name: string; dosage?: string })[];
  suggestedAlarms?: { title: string; time: string }[];
  riskAssessment?: {
    score: number;
    level: 'Low' | 'Moderate' | 'High';
    summary: string;
    nextSteps: string[];
    redFlags: string[];
  } | null;
}

interface ChatMessage {
  role: 'user' | 'bot';
  content: string;
}

interface Reminder {
  id: string;
  title: string;
  time: string;
  active: boolean;
}

function parseTimeTo24h(timeStr: string): string {
  let cleaned = timeStr.trim().toUpperCase();
  
  // Try to parse strings like "08:00 PM", "8:00 PM", "20:00", "8 PM", "8PM", "08:00"
  const ampmMatch = cleaned.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/);
  if (ampmMatch) {
    let hours = parseInt(ampmMatch[1], 10);
    const minutes = ampmMatch[2] ? ampmMatch[2] : "00";
    const ampm = ampmMatch[3];
    if (ampm === "PM" && hours < 12) hours += 12;
    if (ampm === "AM" && hours === 12) hours = 0;
    return `${String(hours).padStart(2, '0')}:${minutes}`;
  }
  
  // Try matching just "8 PM" or "8PM"
  const ampmSimpleMatch = cleaned.match(/^(\d{1,2})\s*(AM|PM)$/);
  if (ampmSimpleMatch) {
    let hours = parseInt(ampmSimpleMatch[1], 10);
    const ampm = ampmSimpleMatch[2];
    if (ampm === "PM" && hours < 12) hours += 12;
    if (ampm === "AM" && hours === 12) hours = 0;
    return `${String(hours).padStart(2, '0')}:00`;
  }

  // Expect HH:MM style check
  const hhmmMatch = cleaned.match(/^(\d{1,2}):(\d{2})$/);
  if (hhmmMatch) {
    let hours = parseInt(hhmmMatch[1], 10);
    let minutes = hhmmMatch[2];
    return `${String(hours).padStart(2, '0')}:${minutes}`;
  }

  return timeStr; // fallback
}

export default function App() {
  const [view, setView] = useState<'home' | 'app'>('home');
  const [activeSection, setActiveSection] = useState<'upload' | 'ocr' | 'ner' | 'analysis' | 'risk' | 'alarms' | 'chatbot'>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [prescriptionType, setPrescriptionType] = useState<'scrambled' | 'printed'>('scrambled');
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  
  // Voice Input/Output States
  const [isListening, setIsListening] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [chatLang, setChatLang] = useState<'en' | 'ta' | 'both'>('both');
  const recognitionRef = useRef<any>(null);

  // Reminders/Alarms States
  const [reminders, setReminders] = useState<Reminder[]>(() => {
    const saved = localStorage.getItem('med_reminders_list');
    return saved ? JSON.parse(saved) : [
      { id: '1', title: 'Morning Multivitamin', time: '08:00', active: true },
      { id: '2', title: 'Evening Painkiller', time: '20:00', active: true }
    ];
  });
  const [newReminderTitle, setNewReminderTitle] = useState('');
  const [newReminderTime, setNewReminderTime] = useState('');
  const [activeTriggeredReminders, setActiveTriggeredReminders] = useState<Reminder[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const sendMessageRef = useRef<(msg: string) => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    localStorage.setItem('med_reminders_list', JSON.stringify(reminders));
  }, [reminders]);

  // Check Alarms every 10 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      const now = new Date();
      const currentHours = String(now.getHours()).padStart(2, '0');
      const currentMinutes = String(now.getMinutes()).padStart(2, '0');
      const currentTimeString = `${currentHours}:${currentMinutes}`;

      reminders.forEach(rem => {
        // Support matching either formatted time
        const normRemTime = parseTimeTo24h(rem.time);
        if (rem.active && normRemTime === currentTimeString) {
          // Check if we already triggered this specific reminder for this exact minute
          const logKey = `${rem.id}-${currentTimeString}`;
          const alreadyLogs = sessionStorage.getItem('triggered_reminders_log');
          const logsList = alreadyLogs ? JSON.parse(alreadyLogs) : [];
          
          if (!logsList.includes(logKey)) {
            // Trigger alarm! Play sound and show floating alert if not already active
            playAlarmSound();
            setActiveTriggeredReminders(prev => {
              if (prev.find(p => p.id === rem.id)) return prev;
              return [...prev, rem];
            });
            
            // Log that this is triggered so we don't trigger it again
            logsList.push(logKey);
            sessionStorage.setItem('triggered_reminders_log', JSON.stringify(logsList));
          }
        }
      });
    }, 10000);

    return () => clearInterval(interval);
  }, [reminders]);

  // Web Speech input initialization
  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      const rec = new SpeechRecognition();
      rec.continuous = false;
      rec.interimResults = false;
      rec.lang = 'en-US';

      rec.onstart = () => {
        setIsListening(true);
      };

      rec.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        if (transcript && transcript.trim()) {
          setInput(transcript);
          // Auto-submit the voice question to the chatbot!
          if (sendMessageRef.current) {
            sendMessageRef.current(transcript);
          }
        }
      };

      rec.onerror = (e: any) => {
        console.error("Speech Recognition Error", e);
        setIsListening(false);
      };

      rec.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = rec;
    }
  }, []);

  // Update speech recognition language preference dynamically
  useEffect(() => {
    if (recognitionRef.current) {
      if (chatLang === 'ta') {
        recognitionRef.current.lang = 'ta-IN';
      } else if (chatLang === 'both') {
        recognitionRef.current.lang = 'en-IN'; // Mixed English-Indian accent recognition
      } else {
        recognitionRef.current.lang = 'en-US';
      }
    }
  }, [chatLang]);

  const toggleListening = () => {
    if (!recognitionRef.current) {
      alert("Voice input is not supported in this browser or frame structure. Please try again in Chrome/Safari or open the app in a new tab to ask questions with your voice.");
      return;
    }

    if (isListening) {
      recognitionRef.current.stop();
    } else {
      try {
        recognitionRef.current.start();
      } catch (err) {
        console.error(err);
      }
    }
  };

  const speakText = (text: string) => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();

    // Clean text of format codes
    const cleanToSpeak = text
      .replace(/\[SET_REMINDER:[^\]]+\]/g, '')
      .replace(/[*_#`\-\[\]]/g, '');

    const utterance = new SpeechSynthesisUtterance(cleanToSpeak);
    
    // Detect Tamil language or if text has Tamil unicode characters
    const hasTamil = /[\u0B80-\u0BFF]/.test(cleanToSpeak);
    const voices = window.speechSynthesis.getVoices();
    
    if (hasTamil || chatLang === 'ta') {
      utterance.lang = 'ta-IN';
      const tamilVoice = voices.find(v => v.lang.startsWith('ta'));
      if (tamilVoice) {
        utterance.voice = tamilVoice;
      }
    } else {
      utterance.lang = 'en-US';
      const englishVoice = voices.find(v => v.lang.startsWith('en') && (v.name.includes('Google') || v.name.includes('Natural')));
      if (englishVoice) {
        utterance.voice = englishVoice;
      }
    }
    
    window.speechSynthesis.speak(utterance);
  };

  const playAlarmSound = () => {
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const playBeep = (startTime: number) => {
        const osc = audioCtx.createOscillator();
        const gainLog = audioCtx.createGain();
        osc.connect(gainLog);
        gainLog.connect(audioCtx.destination);
        
        osc.type = "sine";
        osc.frequency.setValueAtTime(800, startTime);
        gainLog.gain.setValueAtTime(0, startTime);
        gainLog.gain.linearRampToValueAtTime(0.4, startTime + 0.05);
        gainLog.gain.exponentialRampToValueAtTime(0.01, startTime + 0.25);
        
        osc.start(startTime);
        osc.stop(startTime + 0.3);
      };
      
      const now = audioCtx.currentTime;
      playBeep(now);
      playBeep(now + 0.4);
      playBeep(now + 0.8);
    } catch (e) {
      console.error(e);
    }
  };

  const handleAddReminderManual = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newReminderTitle.trim() || !newReminderTime) return;

    const newRem: Reminder = {
      id: Math.random().toString(36).substring(2, 9),
      title: newReminderTitle.trim(),
      time: parseTimeTo24h(newReminderTime),
      active: true
    };
    setReminders(prev => [...prev, newRem]);
    setNewReminderTitle('');
    setNewReminderTime('');
  };

  const toggleReminderActive = (id: string) => {
    setReminders(prev => prev.map(rem => rem.id === id ? { ...rem, active: !rem.active } : rem));
  };

  const deleteReminder = (id: string) => {
    setReminders(prev => prev.filter(rem => rem.id !== id));
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) {
      const selectedFile = e.target.files[0];
      setFile(selectedFile);
      const reader = new FileReader();
      reader.onloadend = () => setPreview(reader.result as string);
      reader.readAsDataURL(selectedFile);
      setResult(null);
      setAnalysisError(null);
      setReminders([]);
      setActiveTriggeredReminders([]);
      localStorage.removeItem('med_reminders_list');
    }
  };

  const handleAnalyze = async () => {
    if (!file) return;
    setLoading(true);
    setAnalysisError(null);
    
    const formData = new FormData();
    formData.append('prescription', file);
    formData.append('prescriptionType', prescriptionType);

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        body: formData,
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Server responded with status ${response.status}`);
      }

      const data = await response.json();
      if (data.error) throw new Error(data.error);
      setResult(data);
      setActiveSection('analysis');

      let initialMsg = "Hi! I've analyzed your prescription. Feel free to ask me anything about it!";
      
      // Auto-schedule alarms from prescription description / parsed suggestedAlarms
      if (data.suggestedAlarms && Array.isArray(data.suggestedAlarms) && data.suggestedAlarms.length > 0) {
        const newAlarms: Reminder[] = data.suggestedAlarms.map((alarm: any) => ({
          id: Math.random().toString(36).substring(2, 9),
          title: alarm.title || 'Medication Alarm',
          time: parseTimeTo24h(alarm.time || '08:00'),
          active: true
        }));
        
        setReminders(newAlarms);
        
        initialMsg += `\n\n⏰ **Auto-scheduled Alarms:**\n` + newAlarms.map(a => `• **${a.title}** at **${a.time}**`).join('\n');
      }

      setMessages([{ role: 'bot', content: initialMsg }]);
      if (voiceEnabled) {
        speakText(initialMsg);
      }
    } catch (error: any) {
      console.error(error);
      setAnalysisError(error?.message === 'Failed to fetch'
        ? 'Cannot reach the local server. Restart it with npm run dev, then try again.'
        : error.message || "Failed to analyze prescription");
    } finally {
      setLoading(false);
    }
  };

  const sendMessageToServer = async (userMsg: string) => {
    if (!userMsg.trim() || chatLoading) return;

    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    setChatLoading(true);

    try {
      const context = result ? 
        `Patient: ${result.patientName}, Doctor: ${result.doctorName}, Condition: ${result.disease}, Medications: ${result.medications.map(m => typeof m === 'string' ? m : m.name).join(', ')}. Analysis: ${result.analysis}` : 
        "No prescription uploaded yet.";

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMsg, context, language: chatLang }),
      });
      const data = await response.json();
      
      let finalReply = data.reply || "";
      
      // Auto Alarm detection from Llama-3 response format
      const reminderMatch = finalReply.match(/\[SET_REMINDER:\s*Title=["']([^"']+)["']\s*,\s*Time=["']([^"']+)["']\]/i);
      if (reminderMatch) {
        const titleVal = reminderMatch[1];
        const timeVal = reminderMatch[2];
        const normalizedTime = parseTimeTo24h(timeVal);
        const rawNewRem: Reminder = {
          id: Math.random().toString(36).substring(2, 9),
          title: titleVal,
          time: normalizedTime,
          active: true
        };
        setReminders(prev => [...prev, rawNewRem]);
        
        finalReply = finalReply.replace(/\[SET_REMINDER:[^\]]+\]/g, '').trim();
        finalReply += `\n\n🔔 *Alarm scheduled:* Remind me to take "${titleVal}" at ${normalizedTime}`;
      }

      setMessages(prev => [...prev, { role: 'bot', content: finalReply }]);
      
      if (voiceEnabled) {
        speakText(finalReply);
      }
    } catch (error) {
      setMessages(prev => [...prev, { role: 'bot', content: "Sorry, I'm having trouble connecting right now." }]);
    } finally {
      setChatLoading(false);
    }
  };

  // Keep reference updated to avoid stale state in speech recognition onresult handler
  useEffect(() => {
    sendMessageRef.current = sendMessageToServer;
  });

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessageToServer(input);
  };

  if (view === 'home') {
    return (
      <div className="min-h-screen bg-white font-sans text-gray-900 selection:bg-blue-100">
        {/* Navbar */}
        <nav className="fixed top-0 w-full z-50 bg-white/80 backdrop-blur-md border-b border-gray-100 h-16 flex items-center px-6 lg:px-12 justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
              <Stethoscope className="text-white w-5 h-5" />
            </div>
            <span className="font-bold text-xl tracking-tight">MedAssist</span>
          </div>
          <button 
            onClick={() => setView('app')}
            className="hidden md:flex items-center gap-2 text-sm font-semibold hover:text-blue-600 transition-colors"
          >
            Go to App <ArrowRight className="w-4 h-4" />
          </button>
        </nav>

        {/* Hero Section */}
        <main className="pt-32 pb-20 px-6 lg:px-12 max-w-7xl mx-auto">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
            >
              <span className="inline-block px-4 py-1.5 bg-blue-50 text-blue-600 rounded-full text-sm font-bold mb-6">
                Next-Gen Medical AI
              </span>
              <h1 className="text-5xl lg:text-7xl font-bold leading-tight mb-8">
                Understand your <span className="text-blue-600 italic">prescription</span> in seconds.
              </h1>
              <p className="text-xl text-gray-500 mb-10 leading-relaxed max-w-lg">
                Upload your doctor's note and let our advanced AI decipher handwriting, extract details, and answer your health queries instantly.
              </p>
              <div className="flex flex-col sm:flex-row gap-4">
                <button 
                  onClick={() => setView('app')}
                  className="px-8 py-4 bg-gray-900 text-white rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-gray-800 transition-all hover:translate-y-[-2px] active:translate-y-0"
                >
                  Start Analysis <Plus className="w-5 h-5 transition-transform group-hover:rotate-90" />
                </button>
              </div>
            </motion.div>

            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.8 }}
              className="relative aspect-square md:aspect-video lg:aspect-square bg-gray-50 rounded-[40px] overflow-hidden group"
            >
              <img 
                src="https://images.unsplash.com/photo-1576091160550-2173dba999ef?q=80&w=2670&auto=format&fit=crop" 
                alt="Medical professional with digital tablet" 
                className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
                referrerPolicy="no-referrer"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/10 to-transparent" />
              
              {/* Feature Tags */}
              <div className="absolute top-6 right-6 flex flex-col gap-3">
                {[
                  { icon: Search, label: "Precise OCR" },
                  { icon: User, label: "NER Extraction" },
                  { icon: MessageCircle, label: "AI Consultation" }
                ].map((item, idx) => (
                  <motion.div 
                    key={idx}
                    initial={{ x: 20, opacity: 0 }}
                    animate={{ x: 0, opacity: 1 }}
                    transition={{ delay: 0.4 + (idx * 0.1) }}
                    className="bg-white/90 backdrop-blur shadow-sm rounded-xl px-4 py-2 flex items-center gap-2 text-sm font-semibold"
                  >
                    <item.icon className="w-4 h-4 text-blue-600" />
                    {item.label}
                  </motion.div>
                ))}
              </div>
            </motion.div>
          </div>
        </main>

        {/* Footer */}
        <footer className="border-t border-gray-100 py-12 px-6 text-center text-gray-400 text-sm">
          <p>© 2024 MedAssist AI. For educational purposes only.</p>
        </footer>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 selection:bg-blue-100">
      {/* App Header */}
      <header className="bg-white border-b border-gray-200 min-h-16 flex items-center px-4 lg:px-6 justify-between sticky top-0 z-40 gap-4">
        <div className="flex items-center gap-2 cursor-pointer" onClick={() => setView('home')}>
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
            <Stethoscope className="text-white w-5 h-5" />
          </div>
          <span className="font-bold text-xl tracking-tight hidden sm:block">MedAssist</span>
        </div>
        
        <nav className="flex flex-1 max-w-3xl items-center justify-center gap-4 overflow-x-auto text-xs font-bold text-gray-500 whitespace-nowrap py-2">
          {([
            ['upload', 'Upload'], ['ocr', 'OCR Raw'], ['ner', 'NER'], ['analysis', 'AI Analysis'],
            ['risk', 'Risk Score'], ['alarms', 'Alarms'], ['chatbot', 'Chatbot']
          ] as const).map(([section, label]) => (
            <button key={section} onClick={() => { setActiveSection(section); if (section === 'chatbot') setChatOpen(true); }} className={activeSection === section ? 'text-blue-600' : 'hover:text-blue-600'}>{label}</button>
          ))}
        </nav>
        <div className="flex items-center gap-4">
          <div className="h-8 w-[1px] bg-gray-200" />
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-blue-50 flex items-center justify-center overflow-hidden">
               <User className="text-blue-600 w-4 h-4" />
            </div>
            <span className="text-sm font-medium text-gray-600 hidden md:block">Guest User</span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className={`mx-auto min-h-[calc(100vh-64px)] p-6 md:p-10 ${activeSection === 'upload' || activeSection === 'alarms' ? 'max-w-4xl' : 'max-w-5xl'}`}>
        {activeSection !== 'chatbot' && (
          <div className="mb-8 text-center">
            <span className="inline-flex items-center rounded-full bg-blue-50 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-blue-600">
              Prescription Workspace
            </span>
            <h1 className="mt-3 text-3xl font-bold tracking-tight text-gray-900">
              {activeSection === 'upload' && 'Upload Prescription'}
              {activeSection === 'ocr' && 'Raw OCR Extraction'}
              {activeSection === 'ner' && 'NER Classification'}
              {activeSection === 'analysis' && 'AI Prescription Analysis'}
              {activeSection === 'risk' && 'Risk Score & Next Steps'}
              {activeSection === 'alarms' && 'Medication Alarms'}
            </h1>
            <p className="mt-2 text-sm text-gray-500">
              {activeSection === 'upload' ? 'Upload a prescription image to begin a new analysis.' : 'Review the selected part of your prescription analysis.'}
            </p>
          </div>
        )}
        {activeSection === 'chatbot' && (
          <motion.aside
            initial={{ opacity: 0, x: -16 }}
            animate={{ opacity: 1, x: 0 }}
            className="max-w-md pt-8 md:pt-16"
          >
            <div className="rounded-[32px] border border-blue-100 bg-white p-8 md:p-10 shadow-sm">
              <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-50">
                <Sparkles className="h-6 w-6 text-blue-600" />
              </div>
              <p className="text-sm font-bold uppercase tracking-[0.18em] text-blue-600">Your daily reminder</p>
              <h1 className="mt-3 text-4xl font-bold leading-tight tracking-tight text-gray-900">Take care of your health.</h1>
              <p className="mt-5 text-lg leading-relaxed text-gray-600">Health is wealth, and all is well when you take one thoughtful step at a time.</p>
              <div className="mt-8 rounded-2xl bg-blue-50 px-5 py-4 text-sm font-medium text-blue-800">Use the chat beside this message for clear, prescription-focused guidance.</div>
            </div>
          </motion.aside>
        )}
        <div className="grid lg:grid-cols-12 gap-8">
          
          {/* Left Column: Upload */}
          <div className={`lg:col-span-12 space-y-6 ${activeSection === 'upload' || activeSection === 'alarms' ? '' : 'hidden'}`}>
            <div id="upload" className={`mx-auto max-w-2xl bg-white rounded-3xl p-8 md:p-10 border border-gray-100 shadow-sm scroll-mt-24 ${activeSection === 'upload' ? '' : 'hidden'}`}>
              <h2 className="text-xl font-bold mb-6">Upload Prescription</h2>
              
              {/* Prescription Type Selector Toggle */}
              <div className="bg-gray-100 p-1 rounded-2xl flex items-center justify-between gap-1 mb-6 border border-gray-100/30">
                <button
                  type="button"
                  onClick={() => setPrescriptionType('scrambled')}
                  className={`flex-1 flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-xs font-bold transition-all cursor-pointer border-0 ${
                    prescriptionType === 'scrambled'
                      ? 'bg-white text-blue-600 shadow-sm'
                      : 'text-gray-500 hover:text-gray-900 bg-transparent'
                  }`}
                >
                  <Sparkles className="w-4 h-4" />
                  Scrambled / Messy
                </button>
                <button
                  type="button"
                  onClick={() => setPrescriptionType('printed')}
                  className={`flex-1 flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-xs font-bold transition-all cursor-pointer border-0 ${
                    prescriptionType === 'printed'
                      ? 'bg-white text-blue-600 shadow-sm'
                      : 'text-gray-500 hover:text-gray-900 bg-transparent'
                  }`}
                >
                  <FileText className="w-4 h-4" />
                  Printed / Clear
                </button>
              </div>
              
              <label 
                className={`relative border-2 border-dashed rounded-2xl flex flex-col items-center justify-center p-12 transition-all cursor-pointer group ${
                  preview ? 'border-blue-200 bg-blue-50/20' : 'border-gray-200 hover:border-blue-400 hover:bg-gray-50'
                }`}
              >
                <input type="file" className="hidden" onChange={handleFileChange} accept="image/*" />
                
                {preview ? (
                  <div className="relative w-full aspect-[3/4] rounded-lg overflow-hidden ring-1 ring-black/5 shadow-inner">
                    <img src={preview} alt="Prescription Preview" className="w-full h-full object-contain" />
                    <button 
                      onClick={(e) => { e.preventDefault(); setFile(null); setPreview(null); setResult(null); setAnalysisError(null); }}
                      className="absolute top-2 right-2 p-1.5 bg-black/50 text-white rounded-full backdrop-blur-sm hover:bg-black/70 transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <div className="text-center">
                    <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-4 group-hover:scale-110 transition-transform">
                      <Upload className="w-8 h-8 text-blue-600" />
                    </div>
                    <p className="font-bold text-gray-900 mb-1">Select or drag file</p>
                    <p className="text-sm text-gray-400">JPG, PNG up to 10MB</p>
                  </div>
                )}
              </label>

              <button 
                disabled={!file || loading}
                onClick={handleAnalyze}
                className="w-full mt-6 bg-blue-600 text-white font-bold py-4 rounded-2xl flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-blue-700 active:scale-[0.98] transition-all shadow-lg shadow-blue-600/20"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Processing with Vision AI...
                  </>
                ) : (
                  <>
                    <Search className="w-5 h-5" />
                    Analyze Now
                  </>
                )}
              </button>
            </div>

            {/* Tips/Safety Section */}
            <div className="hidden bg-blue-600 rounded-3xl p-8 text-white">
              <h3 className="font-bold text-lg mb-4 flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5" />
                How it works
              </h3>
              <ul className="space-y-3 text-blue-100 text-sm">
                <li className="flex gap-2">
                  <span className="font-mono text-xs mt-1">01.</span>
                  Our AI models identify blurry and cursive medical handwriting.
                </li>
                <li className="flex gap-2">
                  <span className="font-mono text-xs mt-1">02.</span>
                  Named entities like Doctor and Medicines are extracted.
                </li>
                <li className="flex gap-2">
                  <span className="font-mono text-xs mt-1">03.</span>
                  Ask our specialized chatbot any follow-up questions or set alarms.
                </li>
              </ul>
            </div>

            {/* Medicines Alarm & Reminders Section */}
            <div id="alarms" className={`mx-auto max-w-2xl bg-white rounded-3xl p-8 md:p-10 border border-gray-100 shadow-sm space-y-6 scroll-mt-24 ${activeSection === 'alarms' ? '' : 'hidden'}`}>
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold flex items-center gap-2">
                  <Bell className="w-5 h-5 text-amber-500 animate-swing" />
                  Tablet Alarms & Reminders
                </h3>
                <span className="text-xs bg-amber-50 text-amber-600 px-2.5 py-1 rounded-full font-bold">
                  {reminders.filter(r => r.active).length} Active
                </span>
              </div>

              {/* Add New Alarm Form */}
              <form onSubmit={handleAddReminderManual} className="grid grid-cols-1 sm:grid-cols-12 gap-2">
                <div className="sm:col-span-7">
                  <input 
                    type="text" 
                    placeholder="e.g. Paracetamol"
                    value={newReminderTitle}
                    onChange={(e) => setNewReminderTitle(e.target.value)}
                    className="w-full bg-gray-50 border-0 rounded-xl px-3 py-2.5 text-xs focus:ring-2 focus:ring-amber-200"
                  />
                </div>
                <div className="sm:col-span-3">
                  <input 
                    type="time"
                    value={newReminderTime}
                    onChange={(e) => setNewReminderTime(e.target.value)}
                    className="w-full bg-gray-50 border-0 rounded-xl px-2 py-2.5 text-xs focus:ring-2 focus:ring-amber-200"
                  />
                </div>
                <div className="sm:col-span-2">
                  <button 
                    type="submit"
                    className="w-full bg-amber-500 hover:bg-amber-600 text-white font-bold h-full rounded-xl flex items-center justify-center p-2.5"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
              </form>

              {/* Alarms list */}
              <div className="space-y-3 max-h-[220px] overflow-y-auto pr-1">
                {reminders.length === 0 ? (
                  <p className="text-xs text-gray-400 text-center py-4">No alarms scheduled yet. Ask the chatbot or add one above!</p>
                ) : (
                  reminders.map((rem) => (
                    <div 
                      key={rem.id} 
                      className={`flex items-center justify-between p-3 rounded-2xl border transition-all ${
                        rem.active 
                          ? 'border-amber-100 bg-amber-50/10' 
                          : 'border-gray-100 bg-gray-50/50 grayscale'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <Clock className={`w-4 h-4 ${rem.active ? 'text-amber-500' : 'text-gray-400'}`} />
                        <div>
                          <p className="text-xs font-bold text-gray-800">{rem.title}</p>
                          <p className="text-[10px] text-gray-400 font-mono font-medium">{rem.time}</p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <button 
                          onClick={() => toggleReminderActive(rem.id)}
                          className={`px-2 py-1 text-[10px] font-bold rounded-lg transition-colors ${
                            rem.active 
                              ? 'bg-amber-100 text-amber-700 hover:bg-amber-250' 
                              : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
                          }`}
                        >
                          {rem.active ? 'Active' : 'Off'}
                        </button>
                        <button 
                          onClick={() => deleteReminder(rem.id)}
                          className="text-gray-300 hover:text-rose-500 p-1 rounded-md transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Right Column: Result */}
          <div className={`lg:col-span-12 mx-auto w-full max-w-4xl ${['ocr', 'ner', 'analysis', 'risk'].includes(activeSection) ? '' : 'hidden'}`}>
            <AnimatePresence mode="wait">
              {result ? (
                <motion.div 
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="space-y-6"
                >
                  {/* Entity Grid */}
                  <div id="ner" className={`grid sm:grid-cols-2 gap-5 scroll-mt-24 ${activeSection === 'ner' ? '' : 'hidden'}`}>
                    {[
                      { icon: User, label: "Doctor", value: result.doctorName },
                      { icon: User, label: "Patient", value: result.patientName },
                      { icon: FileText, label: "Condition", value: result.disease },
                      { icon: Calendar, label: "Date", value: result.date }
                    ].map((item, idx) => (
                      <div key={idx} className="bg-white p-6 rounded-3xl border border-gray-100 shadow-sm flex items-start gap-4">
                        <div className="w-10 h-10 rounded-xl bg-gray-50 flex items-center justify-center flex-shrink-0">
                          <item.icon className="w-5 h-5 text-blue-600" />
                        </div>
                        <div>
                          <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">{item.label}</p>
                          <p className="font-bold text-gray-900">{item.value || "Not found"}</p>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Analysis Box */}
                  <div id="analysis" className={`bg-white rounded-3xl p-8 border border-gray-100 shadow-sm scroll-mt-24 ${activeSection === 'analysis' || activeSection === 'ocr' ? '' : 'hidden'}`}>
                    <div className={`flex items-center justify-between mb-8 pb-4 border-b border-gray-50 ${activeSection === 'analysis' ? '' : 'hidden'}`}>
                      <h3 className="text-xl font-bold flex items-center gap-3">
                        <FileText className="w-5 h-5 text-blue-600" />
                        Full Analysis
                      </h3>
                      <button 
                        onClick={() => setChatOpen(true)}
                        className="text-sm font-bold text-blue-600 flex items-center gap-1 hover:underline"
                      >
                        Ask questions <ArrowRight className="w-4 h-4" />
                      </button>
                    </div>
                    
                    <div className={`prose prose-sm prose-blue max-w-none text-gray-600 leading-relaxed overflow-hidden ${activeSection === 'analysis' ? '' : 'hidden'}`}>
                      <Markdown>{result.analysis}</Markdown>
                    </div>

                    <div className={`mt-8 pt-8 border-t border-gray-50 ${activeSection === 'analysis' ? '' : 'hidden'}`}>
                      <h4 className="font-bold mb-4 text-sm uppercase tracking-widest text-gray-400">Detected Medications</h4>
                      <div className="flex flex-wrap gap-2">
                        {result.medications.map((med, i) => {
                          const medText = typeof med === 'string' ? med : `${med.name}${med.dosage ? ` (${med.dosage})` : ''}`;
                          return (
                            <span key={i} className="px-4 py-2 bg-blue-50 text-blue-700 rounded-full text-xs font-bold ring-1 ring-blue-100">
                              {medText}
                            </span>
                          );
                        })}
                      </div>
                    </div>

                    <div id="ocr" className={`mt-8 p-6 bg-gray-50/80 rounded-2xl border border-gray-100 scroll-mt-24 ${activeSection === 'ocr' ? '' : 'hidden'}`}>
                      <div className="flex items-center justify-between mb-3">
                        <h4 className="font-bold text-xs uppercase tracking-widest text-gray-500">Raw OCR Output</h4>
                        <button 
                          onClick={() => {
                            if (result.ocrText) {
                              navigator.clipboard.writeText(result.ocrText);
                              alert("OCR text copied to clipboard!");
                            }
                          }}
                          className="text-xs font-bold text-blue-600 hover:underline cursor-pointer"
                        >
                          Copy Text
                        </button>
                      </div>
                      <div className="bg-white rounded-xl p-4 border border-gray-100 max-h-60 overflow-y-auto">
                        <pre className="text-xs text-gray-700 font-mono whitespace-pre-wrap leading-relaxed">
                          {result.ocrText || "No raw text read (Direct Multimodal pipeline used)"}
                        </pre>
                      </div>
                    </div>
                  </div>

                  <div id="risk" className={`bg-white rounded-3xl p-8 border border-gray-100 shadow-sm scroll-mt-24 ${activeSection === 'risk' ? '' : 'hidden'}`}>
                    <h3 className="text-xl font-bold flex items-center gap-3 mb-4">
                      <AlertCircle className="w-5 h-5 text-amber-500" />
                      Risk Score & Next Steps
                    </h3>
                    {result.riskAssessment ? (
                      <div className="space-y-4">
                        <div className="flex items-center gap-4">
                          <span className="text-3xl font-black text-amber-600">{result.riskAssessment.score}/100</span>
                          <span className="px-3 py-1 rounded-full bg-amber-50 text-amber-700 text-xs font-bold">{result.riskAssessment.level} attention</span>
                        </div>
                        <p className="text-sm text-gray-600">{result.riskAssessment.summary}</p>
                        <div><h4 className="font-bold text-sm mb-2">Recommended next steps</h4><ul className="list-disc pl-5 text-sm text-gray-600 space-y-1">{result.riskAssessment.nextSteps.map((step, index) => <li key={index}>{step}</li>)}</ul></div>
                        {result.riskAssessment.redFlags?.length > 0 && <div className="rounded-xl bg-rose-50 p-4 text-sm text-rose-800"><strong>Seek urgent medical help for:</strong><ul className="list-disc pl-5 mt-1">{result.riskAssessment.redFlags.map((flag, index) => <li key={index}>{flag}</li>)}</ul></div>}
                      </div>
                    ) : <p className="text-sm text-gray-500">Risk scoring is unavailable until a valid GROQ_API_KEY is configured.</p>}
                  </div>
                </motion.div>
              ) : analysisError ? (
                <motion.div 
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-white rounded-3xl p-10 border border-red-100 shadow-sm flex flex-col items-center justify-center text-center space-y-6"
                >
                  <div className="w-16 h-16 bg-rose-50 rounded-full flex items-center justify-center text-rose-500">
                    <AlertCircle className="w-8 h-8" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-gray-900 mb-2">Prescription Analysis Failed</h3>
                    <p className="text-sm text-gray-500 max-w-sm mx-auto">
                      {analysisError}
                    </p>
                  </div>
                  <div className="bg-rose-50 text-rose-800 text-xs px-5 py-4 rounded-2xl max-w-md text-left space-y-2">
                    <p className="font-bold">Suggested Troubleshooting:</p>
                    <ul className="list-disc pl-4 space-y-1 text-rose-700 font-medium">
                      <li>For “Failed to fetch”, restart the local server with <code>npm run dev</code>.</li>
                      <li>Ensure your prescription photo is clear, focused, and well-lit.</li>
                      <li>Try uploading the image in a widely supported format (PNG or JPEG).</li>
                    </ul>
                  </div>
                  <button 
                    onClick={() => { setFile(null); setPreview(null); setAnalysisError(null); }}
                    className="px-6 py-2.5 bg-gray-100 hover:bg-gray-250 text-gray-700 font-bold text-xs rounded-xl transition-all cursor-pointer"
                  >
                    Clear and Retry
                  </button>
                </motion.div>
              ) : (
                <div className="bg-white rounded-3xl p-16 border border-gray-100 shadow-sm flex flex-col items-center justify-center text-center">
                  <div className="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mb-6">
                    <FileText className="w-10 h-10 text-gray-200" />
                  </div>
                  <h3 className="text-xl font-bold text-gray-900 mb-2">Analysis waiting</h3>
                  <p className="text-gray-400 max-w-xs">Upload a prescription on the left to see the AI analysis here.</p>
                </div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </main>

      {/* Triggered Alarms Floating Popups */}
      <AnimatePresence>
        {activeTriggeredReminders.length > 0 && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-[32px] p-8 max-w-md w-full shadow-2xl text-center space-y-6"
            >
              <div className="w-20 h-20 bg-amber-50 rounded-full flex items-center justify-center mx-auto text-amber-500 animate-bounce">
                <Bell className="w-10 h-10" />
              </div>
              <div>
                <h4 className="text-2xl font-bold text-gray-900">⏰ Medication Alarm!</h4>
                <p className="text-sm text-gray-500 mt-2">It is time for your scheduled dosage.</p>
              </div>

              <div className="bg-gray-50 rounded-2xl p-5 border border-gray-100">
                <p className="font-bold text-xl text-blue-600">{activeTriggeredReminders[0].title}</p>
                <p className="text-xs text-gray-400 mt-1 font-mono">Scheduled for {activeTriggeredReminders[0].time}</p>
              </div>

              <div className="flex gap-3">
                <button 
                  onClick={() => {
                    // Snooze alarm by 5 minutes
                    const now = new Date();
                    now.setMinutes(now.getMinutes() + 5);
                    const hours = String(now.getHours()).padStart(2, '0');
                    const minutes = String(now.getMinutes()).padStart(2, '0');
                    const snoozedTime = `${hours}:${minutes}`;

                    const snoozedRem: Reminder = {
                      id: Math.random().toString(36).substring(2, 9),
                      title: `Snooze: ${activeTriggeredReminders[0].title}`,
                      time: snoozedTime,
                      active: true
                    };
                    setReminders(prev => [...prev, snoozedRem]);
                    setActiveTriggeredReminders(prev => prev.slice(1));
                  }}
                  className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold py-3.5 rounded-xl text-sm transition-colors"
                >
                  Snooze 5 Min
                </button>
                <button 
                  onClick={() => {
                    // Mark as completed / dismiss
                    setActiveTriggeredReminders(prev => prev.slice(1));
                  }}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-bold py-3.5 rounded-xl text-sm shadow-lg shadow-blue-600/25 transition-all"
                >
                  I Took It
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Floating Chatbot */}
      <div className="fixed bottom-6 right-6 z-50">
        <AnimatePresence>
          {chatOpen && (
            <motion.div 
              initial={{ scale: 0.8, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.8, opacity: 0, y: 20 }}
              className="absolute bottom-20 right-0 w-[420px] max-w-[90vw] h-[520px] bg-white rounded-[32px] shadow-2xl border border-gray-100 flex flex-col overflow-hidden"
            >
              {/* Chat Header */}
              <div className="p-6 bg-blue-600 text-white flex items-center justify-between">
                <div>
                  <h4 className="font-bold leading-tight">MedAssist Chat</h4>
                  <p className="text-xs text-blue-100">AI Medical Assistant &amp; Voice Mate</p>
                </div>
                <div className="flex items-center gap-2">
                  {/* TTS Voice Toggle */}
                  <button 
                    onClick={() => {
                      const newVoiceState = !voiceEnabled;
                      setVoiceEnabled(newVoiceState);
                      if (newVoiceState) {
                        speakText(chatLang === 'ta' ? "குரல் உதவி ஆன் செய்யப்பட்டுள்ளது." : "Voice response enabled!");
                      } else {
                        window.speechSynthesis.cancel();
                      }
                    }} 
                    className="bg-white/10 p-2 rounded-full hover:bg-white/20 transition-colors"
                    title={voiceEnabled ? "Mute Bot Speech" : "Unmute Bot Speech"}
                  >
                    {voiceEnabled ? (
                      <Volume2 className="w-4 h-4 text-emerald-300" />
                    ) : (
                      <VolumeX className="w-4 h-4 text-white/50" />
                    )}
                  </button>
                  <button onClick={() => setChatOpen(false)} className="bg-white/10 p-2 rounded-full hover:bg-white/20">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Voice & Language Settings Controls */}
              <div className="bg-blue-50/50 border-b border-blue-100/40 px-5 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 text-xs">
                {/* Voice Toggle Option */}
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-gray-600">Voice Assistant:</span>
                  <button
                    type="button"
                    onClick={() => {
                      const newVoiceState = !voiceEnabled;
                      setVoiceEnabled(newVoiceState);
                      if (newVoiceState) {
                        speakText(chatLang === 'ta' ? "குரல் உதவி ஆன் செய்யப்பட்டுள்ளது." : "Voice response enabled!");
                      } else {
                        window.speechSynthesis.cancel();
                      }
                    }}
                    className={`px-3 py-1 rounded-full font-bold flex items-center gap-1.5 transition-all shadow-sm cursor-pointer ${
                      voiceEnabled 
                        ? 'bg-emerald-500 text-white hover:bg-emerald-600' 
                        : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                    }`}
                  >
                    {voiceEnabled ? (
                      <>
                        <Volume2 className="w-3.5 h-3.5" />
                        <span>ON</span>
                      </>
                    ) : (
                      <>
                        <VolumeX className="w-3.5 h-3.5" />
                        <span>OFF</span>
                      </>
                    )}
                  </button>
                </div>

                {/* Language Select Option */}
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-gray-600">Language:</span>
                  <div className="inline-flex bg-gray-100 p-0.5 rounded-lg border border-gray-200/50">
                    {(['en', 'ta', 'both'] as const).map((lang) => (
                      <button
                        key={lang}
                        type="button"
                        onClick={() => {
                          setChatLang(lang);
                          speakText(lang === 'ta' ? "தமிழ் தேர்ந்தெடுக்கப்பட்டது" : lang === 'en' ? "English selected" : "Bilingual mode activated");
                        }}
                        className={`px-2.5 py-1 text-[10px] font-bold rounded-md transition-all cursor-pointer ${
                          chatLang === lang 
                            ? 'bg-white text-blue-600 shadow-sm' 
                            : 'text-gray-500 hover:text-gray-900'
                        }`}
                      >
                        {lang === 'en' ? 'English' : lang === 'ta' ? 'தமிழ்' : 'Both'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Chat Messages */}
              <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-4">
                {messages.length === 0 && (
                  <div className="text-center py-10">
                    <div className="w-12 h-12 bg-gray-50 rounded-full flex items-center justify-center mx-auto mb-4">
                      <MessageCircle className="w-6 h-6 text-gray-300" />
                    </div>
                    <p className="text-sm text-gray-400">Ask anything about your prescription or set tablet alarms!</p>
                  </div>
                )}
                {messages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} items-end gap-1.5`}>
                    <div className={`max-w-[80%] px-4 py-3 rounded-2xl text-sm shadow-sm ${
                      msg.role === 'user' 
                        ? 'bg-blue-600 text-white rounded-br-none' 
                        : 'bg-gray-100 text-gray-700 rounded-bl-none'
                    }`}>
                      {msg.content}
                    </div>
                    {msg.role === 'bot' && (
                      <button 
                        onClick={() => speakText(msg.content)}
                        className="p-1 hover:bg-gray-100 rounded-full text-gray-400 hover:text-gray-600 transition-colors"
                        title="Read aloud"
                      >
                        <Volume1 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
                {chatLoading && (
                  <div className="flex justify-start">
                    <div className="bg-gray-100 px-4 py-3 rounded-2xl rounded-bl-none">
                      <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                    </div>
                  </div>
                )}
              </div>

              {/* Chat Input */}
              <form onSubmit={handleSendMessage} className="p-4 border-t border-gray-100 flex items-center gap-2">
                {/* Voice Input Button */}
                <button 
                  type="button"
                  onClick={toggleListening}
                  className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all border cursor-pointer ${
                    isListening 
                      ? 'bg-rose-500 text-white animate-pulse border-rose-600' 
                      : 'bg-blue-50 hover:bg-blue-100 text-blue-600 border-blue-100/40'
                  }`}
                  title={isListening ? "Listening... Speak now, stop to send automatically" : "Speak your question directly"}
                >
                  <Mic className="w-5 h-5" />
                </button>

                <input 
                  type="text" 
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={isListening ? "Listening... Speak your question directly" : "Type or tap Mic to speak your question..."}
                  className="flex-1 bg-gray-50 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100"
                />
                
                <button 
                  type="submit"
                  disabled={!input.trim() || chatLoading}
                  className="w-12 h-12 bg-blue-600 text-white rounded-xl flex items-center justify-center disabled:opacity-50 hover:bg-blue-700 transition-all"
                >
                  <Send className="w-5 h-5" />
                </button>
              </form>
            </motion.div>
          )}
        </AnimatePresence>

        <button 
          onClick={() => setChatOpen(!chatOpen)}
          className={`w-14 h-14 rounded-full shadow-xl flex items-center justify-center transition-all duration-300 hover:scale-110 active:scale-95 ${
            chatOpen ? 'bg-gray-900 text-white rotate-90' : 'bg-blue-600 text-white'
          }`}
        >
          {chatOpen ? <X className="w-6 h-6" /> : <MessageCircle className="w-6 h-6" />}
        </button>
      </div>
    </div>
  );
}

import { useState, useEffect, useRef, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  addDoc,
  onSnapshot,
  query,
  orderBy,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
  Timestamp,
  setDoc,
} from 'firebase/firestore';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import type { User } from 'firebase/auth';
import { GoogleGenerativeAI } from '@google/generative-ai';

// ============================================
// Types
// ============================================
interface Message {
  id: string;
  text: string;
  userId: string;
  userName: string;
  timestamp: Timestamp | null;
  isBot?: boolean;
  fileName?: string;
  fileType?: string;
  fileSize?: number;
}

interface Task {
  id: string;
  title: string;
  completed: boolean;
  assignee?: string;
  priority: 'low' | 'medium' | 'high';
  createdAt: Timestamp | null;
  createdBy: string;
}

interface Channel {
  id: string;
  name: string;
  createdAt: Timestamp | null;
  createdBy: string;
}

interface SharedFile {
  id: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  uploadedBy: string;
  uploadedAt: Timestamp | null;
  channel: string;
  content?: string;
}

interface OnlineUser {
  id: string;
  name: string;
  status: 'online' | 'away' | 'busy';
  lastSeen: Timestamp | null;
  avatar: string;
  color: string;
  isVPN?: boolean;
}

interface UserSettings {
  avatar: string;
  color: string;
  status: 'online' | 'away' | 'busy';
  statusMessage: string;
}

interface AISummary {
  decisions: string[];
  todos: string[];
  pending: string[];
  timestamp: Date;
}

type Theme = 'light' | 'dark' | 'system';

// ============================================
// Constants
// ============================================
const STORAGE_KEYS = {
  FIREBASE_CONFIG: 'devstream_firebase_config',
  GEMINI_KEY: 'devstream_gemini_key',
  USER_NAME: 'devstream_user_name',
  USER_SETTINGS: 'devstream_user_settings',
  THEME: 'devstream_theme',
};

const AVATAR_OPTIONS = ['😀', '😎', '🚀', '💻', '🎨', '🔥', '⚡', '🌟', '🎯', '🦊', '🐱', '🐶', '🦁', '🐸', '🦄'];
const COLOR_OPTIONS = ['#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f43f5e', '#f97316', '#eab308', '#84cc16', '#22c55e', '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6'];

const APP_ID = 'devstream-app';

function App() {
  // ============================================
  // State
  // ============================================
  const [firebaseConfig, setFirebaseConfig] = useState<string>('');
  const [geminiApiKey, setGeminiApiKey] = useState<string>('');
  const [isConfigured, setIsConfigured] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [userName, setUserName] = useState<string>('');
  const [isUserNameSet, setIsUserNameSet] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);

  // User settings
  const [userSettings, setUserSettings] = useState<UserSettings>({
    avatar: '😀',
    color: '#6366f1',
    status: 'online',
    statusMessage: '',
  });
  const [showSettings, setShowSettings] = useState(false);
  const [isVPN, setIsVPN] = useState(false);

  // Online users
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);

  // Chat state
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [isTyping, setIsTyping] = useState(false);

  // Task state
  const [tasks, setTasks] = useState<Task[]>([]);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [taskFilter, setTaskFilter] = useState<'all' | 'active' | 'completed'>('all');

  // Channel state
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeChannel, setActiveChannel] = useState('general');
  const [newChannelName, setNewChannelName] = useState('');
  const [showChannelForm, setShowChannelForm] = useState(false);

  // File state
  const [sharedFiles, setSharedFiles] = useState<SharedFile[]>([]);

  // AI state
  const [aiSummary, setAiSummary] = useState<AISummary | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [fileSummary, setFileSummary] = useState('');
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [uploadedFileName, setUploadedFileName] = useState('');

  // Right panel tab
  const [rightPanelTab, setRightPanelTab] = useState<'tasks' | 'files' | 'users' | 'summary' | 'ai'>('tasks');

  // Command palette
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [commandSearch, setCommandSearch] = useState('');

  // Refs
  const chatEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatFileInputRef = useRef<HTMLInputElement>(null);
  const messageInputRef = useRef<HTMLInputElement>(null);
  const dbRef = useRef<ReturnType<typeof getFirestore> | null>(null);
  const genAIRef = useRef<GoogleGenerativeAI | null>(null);

  // Get current theme colors
  const t = themes[resolvedTheme];

  // ============================================
  // Theme Management
  // ============================================
  useEffect(() => {
    const savedTheme = localStorage.getItem(STORAGE_KEYS.THEME) as Theme | null;
    if (savedTheme) setTheme(savedTheme);
  }, []);

  useEffect(() => {
    const updateResolvedTheme = () => {
      if (theme === 'system') {
        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        setResolvedTheme(isDark ? 'dark' : 'light');
      } else {
        setResolvedTheme(theme);
      }
    };

    updateResolvedTheme();
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', updateResolvedTheme);
    return () => mediaQuery.removeEventListener('change', updateResolvedTheme);
  }, [theme]);

  const changeTheme = (newTheme: Theme) => {
    setTheme(newTheme);
    localStorage.setItem(STORAGE_KEYS.THEME, newTheme);
  };

  // ============================================
  // VPN Detection (improved with multiple methods)
  // ============================================
  useEffect(() => {
    const checkVPN = async () => {
      try {
        // Method 1: Check with ipapi.co
        const response = await fetch('https://ipapi.co/json/', {
          headers: { 'Accept': 'application/json' }
        });
        const data = await response.json();

        // Common VPN/Proxy indicators
        const vpnIndicators = [
          'vpn', 'proxy', 'hosting', 'datacenter', 'cloud', 'server',
          'digital ocean', 'amazon', 'google cloud', 'microsoft azure',
          'linode', 'vultr', 'ovh', 'hetzner', 'scaleway'
        ];

        const orgLower = (data.org || '').toLowerCase();
        const ispLower = (data.asn || '').toLowerCase();
        const connectionType = (data.connection_type || '').toLowerCase();

        const isLikelyVPN = vpnIndicators.some(indicator =>
          orgLower.includes(indicator) || ispLower.includes(indicator)
        ) || connectionType === 'datacenter';

        // Method 2: Check WebRTC leak (basic)
        let webRTCLeak = false;
        try {
          const pc = new RTCPeerConnection({ iceServers: [] });
          pc.createDataChannel('');
          await pc.createOffer().then(offer => pc.setLocalDescription(offer));

          await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => resolve(), 1000);
            pc.onicecandidate = (e) => {
              if (e.candidate?.candidate) {
                const candidateStr = e.candidate.candidate;
                // Check for local IP patterns that might indicate VPN
                if (candidateStr.includes('10.') || candidateStr.includes('172.') || candidateStr.includes('192.168.')) {
                  webRTCLeak = true;
                }
              }
              if (!e.candidate) {
                clearTimeout(timeout);
                resolve();
              }
            };
          });
          pc.close();
        } catch {
          // WebRTC not available or blocked
        }

        const detected = isLikelyVPN || webRTCLeak;
        setIsVPN(detected);
      } catch {
        // If check fails, don't show VPN status
        setIsVPN(false);
      }
    };

    checkVPN();
  }, []);

  // ============================================
  // Keyboard Shortcuts
  // ============================================
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setShowCommandPalette(prev => !prev);
      }
      if (e.key === 'Escape') {
        setShowCommandPalette(false);
        setShowSettings(false);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault();
        messageInputRef.current?.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // ============================================
  // Load saved credentials
  // ============================================
  useEffect(() => {
    const savedConfig = localStorage.getItem(STORAGE_KEYS.FIREBASE_CONFIG);
    const savedGeminiKey = localStorage.getItem(STORAGE_KEYS.GEMINI_KEY);
    const savedUserName = localStorage.getItem(STORAGE_KEYS.USER_NAME);
    const savedSettings = localStorage.getItem(STORAGE_KEYS.USER_SETTINGS);

    if (savedConfig) setFirebaseConfig(savedConfig);
    if (savedGeminiKey) setGeminiApiKey(savedGeminiKey);
    if (savedUserName) setUserName(savedUserName);
    if (savedSettings) {
      try {
        setUserSettings(JSON.parse(savedSettings));
      } catch { /* ignore */ }
    }

    if (savedConfig && savedUserName) {
      try {
        const config = JSON.parse(savedConfig);
        const app = initializeApp(config);
        dbRef.current = getFirestore(app);
        const auth = getAuth(app);

        signInAnonymously(auth).catch(console.error);

        onAuthStateChanged(auth, (user) => {
          if (user) {
            setUser(user);
            setIsConfigured(true);
            setIsUserNameSet(true);
          }
        });

        if (savedGeminiKey) {
          genAIRef.current = new GoogleGenerativeAI(savedGeminiKey);
        }
      } catch (e) {
        console.error('Auto-login failed:', e);
      }
    }
  }, []);

  // ============================================
  // Update presence
  // ============================================
  useEffect(() => {
    if (!dbRef.current || !user || !userName) return;

    const presenceRef = doc(
      dbRef.current,
      'artifacts', APP_ID, 'public', 'data', 'presence', user.uid
    );

    const updatePresence = () => {
      setDoc(presenceRef, {
        name: userName,
        status: userSettings.status,
        lastSeen: serverTimestamp(),
        avatar: userSettings.avatar,
        color: userSettings.color,
        isVPN: isVPN,
      });
    };

    updatePresence();
    const interval = setInterval(updatePresence, 30000);
    return () => clearInterval(interval);
  }, [user, userName, userSettings, isVPN]);

  // ============================================
  // Firebase Initialization
  // ============================================
  const initializeFirebase = useCallback(() => {
    try {
      const config = JSON.parse(firebaseConfig);
      const app = initializeApp(config);
      dbRef.current = getFirestore(app);
      const auth = getAuth(app);

      signInAnonymously(auth).catch(console.error);

      onAuthStateChanged(auth, (user) => {
        if (user) {
          setUser(user);
          setIsConfigured(true);
          if (rememberMe) {
            localStorage.setItem(STORAGE_KEYS.FIREBASE_CONFIG, firebaseConfig);
            localStorage.setItem(STORAGE_KEYS.GEMINI_KEY, geminiApiKey);
          }
        }
      });
    } catch {
      alert('Invalid Firebase config JSON');
    }
  }, [firebaseConfig, geminiApiKey, rememberMe]);

  // ============================================
  // Save username & settings
  // ============================================
  const handleSetUserName = () => {
    if (userName.trim()) {
      setIsUserNameSet(true);
      if (rememberMe) {
        localStorage.setItem(STORAGE_KEYS.USER_NAME, userName.trim());
        localStorage.setItem(STORAGE_KEYS.USER_SETTINGS, JSON.stringify(userSettings));
      }
    }
  };

  const saveSettings = () => {
    localStorage.setItem(STORAGE_KEYS.USER_SETTINGS, JSON.stringify(userSettings));
    setShowSettings(false);
  };

  // ============================================
  // Logout
  // ============================================
  const handleLogout = () => {
    Object.values(STORAGE_KEYS).forEach(key => localStorage.removeItem(key));
    window.location.reload();
  };

  // ============================================
  // Initialize Gemini
  // ============================================
  useEffect(() => {
    if (geminiApiKey) {
      genAIRef.current = new GoogleGenerativeAI(geminiApiKey);
    }
  }, [geminiApiKey]);

  // ============================================
  // Firestore Listeners
  // ============================================
  useEffect(() => {
    if (!dbRef.current || !user) return;

    const channelsRef = collection(dbRef.current, 'artifacts', APP_ID, 'public', 'data', 'channels');
    const channelsQuery = query(channelsRef, orderBy('createdAt', 'asc'));

    const unsubChannels = onSnapshot(channelsQuery, (snapshot) => {
      const channelList: Channel[] = [];
      snapshot.forEach((doc) => channelList.push({ id: doc.id, ...doc.data() } as Channel));
      if (channelList.length === 0) {
        addDoc(channelsRef, { name: 'general', createdAt: serverTimestamp(), createdBy: 'system' });
      } else {
        setChannels(channelList);
        if (!channelList.find(c => c.name === activeChannel)) {
          setActiveChannel(channelList[0].name);
        }
      }
    });

    const tasksRef = collection(dbRef.current, 'artifacts', APP_ID, 'public', 'data', 'tasks');
    const tasksQuery = query(tasksRef, orderBy('createdAt', 'desc'));
    const unsubTasks = onSnapshot(tasksQuery, (snapshot) => {
      const taskList: Task[] = [];
      snapshot.forEach((doc) => taskList.push({ id: doc.id, ...doc.data() } as Task));
      setTasks(taskList);
    });

    const filesRef = collection(dbRef.current, 'artifacts', APP_ID, 'public', 'data', 'files');
    const filesQuery = query(filesRef, orderBy('uploadedAt', 'desc'));
    const unsubFiles = onSnapshot(filesQuery, (snapshot) => {
      const fileList: SharedFile[] = [];
      snapshot.forEach((doc) => fileList.push({ id: doc.id, ...doc.data() } as SharedFile));
      setSharedFiles(fileList);
    });

    const presenceRef = collection(dbRef.current, 'artifacts', APP_ID, 'public', 'data', 'presence');
    const unsubPresence = onSnapshot(presenceRef, (snapshot) => {
      const now = Date.now();
      const users: OnlineUser[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        const lastSeen = data.lastSeen?.toDate?.()?.getTime() || 0;
        if (now - lastSeen < 60000) {
          users.push({ id: doc.id, ...data } as OnlineUser);
        }
      });
      setOnlineUsers(users);
    });

    return () => {
      unsubChannels();
      unsubTasks();
      unsubFiles();
      unsubPresence();
    };
  }, [user, activeChannel]);

  // Messages listener
  useEffect(() => {
    if (!dbRef.current || !user || !activeChannel) return;

    const messagesRef = collection(dbRef.current, 'artifacts', APP_ID, 'public', 'data', 'channelMessages', activeChannel, 'messages');
    const messagesQuery = query(messagesRef, orderBy('timestamp', 'asc'));

    const unsubMessages = onSnapshot(messagesQuery, (snapshot) => {
      const msgs: Message[] = [];
      snapshot.forEach((doc) => msgs.push({ id: doc.id, ...doc.data() } as Message));
      setMessages(msgs);
    });

    return () => unsubMessages();
  }, [user, activeChannel]);

  // Auto scroll
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ============================================
  // Channel Functions
  // ============================================
  const createChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newChannelName.trim() || !dbRef.current || !user) return;

    const channelName = newChannelName.trim().toLowerCase().replace(/\s+/g, '-');
    if (channels.find(c => c.name === channelName)) {
      alert('Channel already exists!');
      return;
    }

    const channelsRef = collection(dbRef.current, 'artifacts', APP_ID, 'public', 'data', 'channels');
    await addDoc(channelsRef, { name: channelName, createdAt: serverTimestamp(), createdBy: userName });

    setNewChannelName('');
    setShowChannelForm(false);
    setActiveChannel(channelName);
  };

  const deleteChannel = async (channelId: string, channelName: string) => {
    if (!dbRef.current || channelName === 'general') return;
    if (!confirm(`Delete #${channelName}?`)) return;

    await deleteDoc(doc(dbRef.current, 'artifacts', APP_ID, 'public', 'data', 'channels', channelId));
    if (activeChannel === channelName) setActiveChannel('general');
  };

  // ============================================
  // AI Functions
  // ============================================
  const callGemini = async (prompt: string): Promise<string> => {
    if (!genAIRef.current) return 'Gemini API key not configured';
    try {
      const model = genAIRef.current.getGenerativeModel({ model: 'gemini-2.5-flash-preview-05-20' });
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (error) {
      console.error('Gemini error:', error);
      return 'AI request failed. Please check your API key.';
    }
  };

  const handleAIChat = async (userMessage: string) => {
    if (!dbRef.current || !user) return;
    setIsTyping(true);

    const messagesRef = collection(dbRef.current, 'artifacts', APP_ID, 'public', 'data', 'channelMessages', activeChannel, 'messages');
    const recentMessages = messages.slice(-10).map(m => `${m.userName}: ${m.text}`).join('\n');

    const prompt = `You are DevStream AI, a helpful assistant. Be concise and friendly.

Recent conversation:
${recentMessages}

User: ${userMessage}

Respond naturally:`;

    const response = await callGemini(prompt);
    await addDoc(messagesRef, { text: response, userId: 'ai-bot', userName: 'DevStream AI', timestamp: serverTimestamp(), isBot: true });
    setIsTyping(false);
  };

  const summarizeConversation = async () => {
    if (!messages.length) return;
    setIsAiLoading(true);

    const conversationText = messages.slice(-50).map(m => `${m.userName}: ${m.text}`).join('\n');
    const prompt = `Analyze this conversation:
${conversationText}

Return JSON: {"decisions": [], "todos": [], "pending": []}`;

    const response = await callGemini(prompt);
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        setAiSummary({ decisions: parsed.decisions || [], todos: parsed.todos || [], pending: parsed.pending || [], timestamp: new Date() });
        setRightPanelTab('summary');
      }
    } catch { /* ignore */ }
    setIsAiLoading(false);
  };

  const summarizeFile = async () => {
    if (!fileContent.trim()) return;
    setIsAiLoading(true);
    const response = await callGemini(`Analyze this code:\n${fileContent}\n\nProvide a brief summary.`);
    setFileSummary(response);
    setIsAiLoading(false);
  };

  // ============================================
  // File Functions
  // ============================================
  const handleChatFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !dbRef.current || !user) return;
    if (file.size > 500 * 1024) { alert('Max 500KB'); return; }

    const reader = new FileReader();
    reader.onload = async (event) => {
      const content = event.target?.result as string;
      const filesRef = collection(dbRef.current!, 'artifacts', APP_ID, 'public', 'data', 'files');
      await addDoc(filesRef, { fileName: file.name, fileType: file.type || 'text/plain', fileSize: file.size, uploadedBy: userName, uploadedAt: serverTimestamp(), channel: activeChannel, content: content.substring(0, 50000) });

      const messagesRef = collection(dbRef.current!, 'artifacts', APP_ID, 'public', 'data', 'channelMessages', activeChannel, 'messages');
      await addDoc(messagesRef, { text: `📎 Shared: ${file.name}`, userId: user.uid, userName, timestamp: serverTimestamp(), isBot: false, fileName: file.name, fileType: file.type, fileSize: file.size });
    };
    reader.readAsText(file);
    if (chatFileInputRef.current) chatFileInputRef.current.value = '';
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || file.size > 1024 * 1024) return;
    const reader = new FileReader();
    reader.onload = (event) => { setFileContent(event.target?.result as string); setUploadedFileName(file.name); setFileSummary(''); };
    reader.readAsText(file);
  };

  const clearFile = () => { setFileContent(''); setUploadedFileName(''); setFileSummary(''); if (fileInputRef.current) fileInputRef.current.value = ''; };

  const deleteSharedFile = async (fileId: string) => {
    if (!dbRef.current) return;
    await deleteDoc(doc(dbRef.current, 'artifacts', APP_ID, 'public', 'data', 'files', fileId));
  };

  // ============================================
  // Message Functions
  // ============================================
  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || !dbRef.current || !user) return;

    const messageText = newMessage.trim();
    setNewMessage('');

    const messagesRef = collection(dbRef.current, 'artifacts', APP_ID, 'public', 'data', 'channelMessages', activeChannel, 'messages');
    await addDoc(messagesRef, { text: messageText, userId: user.uid, userName, timestamp: serverTimestamp(), isBot: false });

    if (messageText.toLowerCase().includes('@ai') || messageText.toLowerCase().startsWith('/ai ')) {
      const q = messageText.replace(/@ai/gi, '').replace(/^\/ai /i, '').trim();
      if (q) await handleAIChat(q);
    }
  };

  // ============================================
  // Task Functions
  // ============================================
  const addTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTaskTitle.trim() || !dbRef.current) return;
    const tasksRef = collection(dbRef.current, 'artifacts', APP_ID, 'public', 'data', 'tasks');
    await addDoc(tasksRef, { title: newTaskTitle.trim(), completed: false, priority: 'medium', createdAt: serverTimestamp(), createdBy: userName });
    setNewTaskTitle('');
  };

  const toggleTask = async (taskId: string, completed: boolean) => {
    if (!dbRef.current) return;
    await updateDoc(doc(dbRef.current, 'artifacts', APP_ID, 'public', 'data', 'tasks', taskId), { completed: !completed });
  };

  const deleteTask = async (taskId: string) => {
    if (!dbRef.current) return;
    await deleteDoc(doc(dbRef.current, 'artifacts', APP_ID, 'public', 'data', 'tasks', taskId));
  };

  const updateTaskPriority = async (taskId: string, priority: 'low' | 'medium' | 'high') => {
    if (!dbRef.current) return;
    await updateDoc(doc(dbRef.current, 'artifacts', APP_ID, 'public', 'data', 'tasks', taskId), { priority });
  };

  const filteredTasks = tasks.filter((task) => taskFilter === 'all' ? true : taskFilter === 'active' ? !task.completed : task.completed);
  const channelFiles = sharedFiles.filter(f => f.channel === activeChannel);

  const formatFileSize = (bytes: number) => bytes < 1024 ? bytes + ' B' : bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / (1024 * 1024)).toFixed(1) + ' MB';

  // Command palette actions
  const commands = [
    { name: 'New Task', action: () => { setRightPanelTab('tasks'); setShowCommandPalette(false); }, icon: '📝' },
    { name: 'Summarize Chat', action: () => { summarizeConversation(); setShowCommandPalette(false); }, icon: '✨' },
    { name: 'Upload File', action: () => { chatFileInputRef.current?.click(); setShowCommandPalette(false); }, icon: '📎' },
    { name: 'Create Channel', action: () => { setShowChannelForm(true); setShowCommandPalette(false); }, icon: '#' },
    { name: 'Settings', action: () => { setShowSettings(true); setShowCommandPalette(false); }, icon: '⚙️' },
    { name: 'View Online Users', action: () => { setRightPanelTab('users'); setShowCommandPalette(false); }, icon: '👥' },
    { name: 'Light Theme', action: () => { changeTheme('light'); setShowCommandPalette(false); }, icon: '☀️' },
    { name: 'Dark Theme', action: () => { changeTheme('dark'); setShowCommandPalette(false); }, icon: '🌙' },
    { name: 'System Theme', action: () => { changeTheme('system'); setShowCommandPalette(false); }, icon: '💻' },
  ];

  const filteredCommands = commands.filter(c => c.name.toLowerCase().includes(commandSearch.toLowerCase()));

  // ============================================
  // Config Screen
  // ============================================
  if (!isConfigured) {
    return (
      <div className="h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 flex items-center justify-center p-4">
        <div className="bg-gray-800/80 backdrop-blur-xl rounded-2xl p-8 max-w-lg w-full shadow-2xl border border-gray-700/50">
          <div className="text-center mb-8">
            <div className="text-5xl mb-4">⚡</div>
            <h1 className="text-3xl font-bold text-white mb-2">DevStream</h1>
            <p className="text-gray-400">Configure your workspace</p>
          </div>

          <div className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Firebase Config (JSON)</label>
              <textarea value={firebaseConfig} onChange={(e) => setFirebaseConfig(e.target.value)} className="w-full h-32 bg-gray-900/50 text-white rounded-xl p-3 border border-gray-600/50 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 outline-none font-mono text-sm transition-all" placeholder='{"apiKey": "...", ...}' />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Gemini API Key</label>
              <input type="password" value={geminiApiKey} onChange={(e) => setGeminiApiKey(e.target.value)} className="w-full bg-gray-900/50 text-white rounded-xl p-3 border border-gray-600/50 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 outline-none transition-all" placeholder="Enter your Gemini API key" />
            </div>
            <label className="flex items-center gap-3 text-gray-300 cursor-pointer group">
              <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${rememberMe ? 'bg-indigo-600 border-indigo-600' : 'border-gray-500 group-hover:border-indigo-500'}`}>
                {rememberMe && <span className="text-white text-xs">✓</span>}
              </div>
              <input type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} className="hidden" />
              <span className="text-sm">Remember me</span>
            </label>
            <button onClick={initializeFirebase} disabled={!firebaseConfig} className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:from-gray-600 disabled:to-gray-600 disabled:cursor-not-allowed text-white font-medium py-3 rounded-xl transition-all shadow-lg shadow-indigo-500/25">
              Connect to Workspace
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ============================================
  // Username Screen
  // ============================================
  if (!isUserNameSet) {
    return (
      <div className="h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 flex items-center justify-center p-4">
        <div className="bg-gray-800/80 backdrop-blur-xl rounded-2xl p-8 max-w-md w-full shadow-2xl border border-gray-700/50">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-white mb-2">Welcome to DevStream</h1>
            <p className="text-gray-400">Customize your profile</p>
          </div>

          <form onSubmit={(e) => { e.preventDefault(); handleSetUserName(); }} className="space-y-6">
            <div className="flex justify-center">
              <div className="w-20 h-20 rounded-2xl flex items-center justify-center text-4xl shadow-lg" style={{ backgroundColor: userSettings.color }}>
                {userSettings.avatar}
              </div>
            </div>

            <div>
              <label className={`block text-xs ${resolvedTheme === 'dark' ? 'text-zinc-500' : 'text-stone-500'} mb-3 uppercase tracking-wide font-medium`}>Avatar</label>
              <div className="flex flex-wrap gap-2 justify-center">
                {AVATAR_OPTIONS.map((avatar) => (
                  <button key={avatar} type="button" onClick={() => setUserSettings(s => ({ ...s, avatar }))} className={`w-10 h-10 rounded-lg flex items-center justify-center text-xl transition-all ${userSettings.avatar === avatar ? 'bg-indigo-600 ring-2 ring-indigo-400' : 'bg-gray-700 hover:bg-gray-600'}`}>
                    {avatar}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-2">Choose Color</label>
              <div className="flex flex-wrap gap-2 justify-center">
                {COLOR_OPTIONS.map((color) => (
                  <button key={color} type="button" onClick={() => setUserSettings(s => ({ ...s, color }))} className={`w-8 h-8 rounded-full transition-all ${userSettings.color === color ? 'ring-2 ring-offset-2 ' + (resolvedTheme === 'dark' ? 'ring-white ring-offset-zinc-900' : 'ring-stone-900 ring-offset-white') : 'hover:scale-110'}`} style={{ backgroundColor: color }} />
                ))}
              </div>
            </div>

            <input type="text" value={userName} onChange={(e) => setUserName(e.target.value)} className="w-full bg-gray-900/50 text-white rounded-xl p-3 border border-gray-600/50 focus:border-indigo-500 outline-none text-center text-lg" placeholder="Your display name" autoFocus />

            <button type="submit" disabled={!userName.trim()} className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:from-gray-600 disabled:to-gray-600 text-white font-medium py-3 rounded-xl transition-all shadow-lg shadow-indigo-500/25">
              Enter Workspace
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ============================================
  // Main App
  // ============================================
  return (
    <div className="h-screen flex flex-col bg-gray-900 text-gray-100 overflow-hidden">
      {/* Header */}
      <header className="h-12 bg-gray-800/80 backdrop-blur-sm border-b border-gray-700/50 flex items-center px-4 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xl">⚡</span>
          <span className="font-bold text-white">DevStream</span>
        </div>

        {isVPN && (
          <div className="ml-4 px-2 py-1 bg-amber-500/20 text-amber-400 rounded-full text-xs flex items-center gap-1">
            <span>🔒</span> VPN Detected
          </div>
        )}

        <div className="ml-auto flex items-center gap-3">
          <kbd className="hidden sm:inline-flex items-center gap-1 px-2 py-1 bg-gray-700/50 rounded text-xs text-gray-400">
            <span>⌘</span>K
          </kbd>
          <button onClick={() => setShowCommandPalette(true)} className={`p-2 rounded-lg ${t.bgHover} ${t.textSecondary} transition-colors`}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
          </button>
          <button onClick={() => setShowSettings(true)} className={`p-2 rounded-lg ${t.bgHover} ${t.textSecondary} transition-colors`}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
          </button>
          <div className="flex items-center gap-2 ml-2">
            <div className="w-7 h-7 rounded-full flex items-center justify-center text-sm" style={{ backgroundColor: userSettings.color }}>
              {userSettings.avatar}
            </div>
            <span className={`text-sm font-medium hidden sm:inline ${t.textSecondary}`}>{userName}</span>
          </div>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar */}
        <div className={`w-60 ${t.bgSecondary} flex flex-col border-r ${t.border} flex-shrink-0`}>
          <div className="flex-1 overflow-y-auto p-3">
            <div className="flex items-center justify-between mb-3 px-2">
              <span className={`text-xs font-semibold ${t.textMuted} uppercase tracking-wide`}>Channels</span>
              <button onClick={() => setShowChannelForm(!showChannelForm)} className={`w-6 h-6 rounded-md ${t.bgHover} ${t.textMuted} flex items-center justify-center transition-colors`}>+</button>
            </div>

            {showChannelForm && (
              <form onSubmit={createChannel} className="mb-2 px-2">
                <input type="text" value={newChannelName} onChange={(e) => setNewChannelName(e.target.value)} className="w-full bg-gray-700 text-white rounded px-2 py-1 text-sm border border-gray-600" placeholder="channel-name" autoFocus />
                <div className="flex gap-1 mt-1">
                  <button type="submit" disabled={!newChannelName.trim()} className="flex-1 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-600 text-white text-xs py-1 rounded">Create</button>
                  <button type="button" onClick={() => { setShowChannelForm(false); setNewChannelName(''); }} className="flex-1 bg-gray-600 text-white text-xs py-1 rounded">Cancel</button>
                </div>
              </form>
            )}

            {channels.map((channel) => (
              <div key={channel.id} className={`group flex items-center justify-between rounded-lg mb-1 transition-all ${activeChannel === channel.name ? 'bg-indigo-600/80 text-white' : 'text-gray-400 hover:bg-gray-700/50'}`}>
                <button onClick={() => setActiveChannel(channel.name)} className="flex-1 text-left px-3 py-2 flex items-center gap-2">
                  <span className="opacity-60">#</span>
                  {channel.name}
                </button>
                {channel.name !== 'general' && (
                  <button onClick={() => deleteChannel(channel.id, channel.name)} className="px-2 text-gray-500 hover:text-red-400 opacity-0 group-hover:opacity-100">×</button>
                )}
              </div>
            ))}

            {/* Online Users Preview */}
            <div className={`mt-6 pt-4 border-t ${t.borderLight}`}>
              <div className="flex items-center justify-between mb-3 px-2">
                <span className={`text-xs font-semibold ${t.textMuted} uppercase tracking-wide`}>Online — {onlineUsers.length}</span>
              </div>
              <div className="flex flex-wrap gap-1.5 px-2">
                {onlineUsers.slice(0, 8).map((u) => (
                  <div key={u.id} className="w-8 h-8 rounded-lg flex items-center justify-center text-sm relative shadow-sm" style={{ backgroundColor: u.color }} title={u.name}>
                    {u.avatar}
                    {u.isVPN && <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-emerald-500 border-2 border-zinc-900" />}
                  </div>
                ))}
                {onlineUsers.length > 8 && <span className={`text-xs ${t.textMuted} self-center ml-1`}>+{onlineUsers.length - 8}</span>}
              </div>
            </div>
          </div>

          {/* User Info */}
          <div className={`p-3 border-t ${t.border} flex-shrink-0`}>
            <div className="flex items-center gap-3 px-2">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg relative shadow-sm" style={{ backgroundColor: userSettings.color }}>
                {userSettings.avatar}
                <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 ${resolvedTheme === 'dark' ? 'border-zinc-900' : 'border-white'} ${userSettings.status === 'online' ? 'bg-emerald-500' : userSettings.status === 'away' ? 'bg-amber-500' : 'bg-rose-500'}`} />
              </div>
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-medium truncate`}>{userName}</div>
                <div className={`text-xs ${t.textMuted} capitalize`}>{userSettings.status}</div>
              </div>
              <button onClick={handleLogout} className={`${t.textMuted} hover:text-rose-500 transition-colors`} title="Logout">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
              </button>
            </div>
          </div>
        </div>

        {/* Main Chat Area */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <div className={`h-14 border-b ${t.border} flex items-center px-5 ${t.bgSecondary} flex-shrink-0`}>
            <span className={`${t.textMuted} mr-2 text-lg`}>#</span>
            <h2 className="font-semibold">{activeChannel}</h2>
            <div className="ml-auto flex items-center gap-2">
              <button onClick={summarizeConversation} disabled={isAiLoading} className="px-3 py-1.5 bg-indigo-600/80 hover:bg-indigo-600 disabled:bg-gray-600 text-white text-sm rounded-lg flex items-center gap-2 transition-all">
                {isAiLoading ? '⏳' : '✨'} Summarize
              </button>
            </div>
          </div>

          {/* Messages - Fixed height with scroll */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 && (
              <div className="text-center py-16">
                <div className={`w-16 h-16 mx-auto mb-4 rounded-2xl ${t.bgTertiary} flex items-center justify-center`}>
                  <span className="text-2xl">💬</span>
                </div>
                <p className={`${t.textSecondary} mb-1`}>No messages yet</p>
                <p className={`text-sm ${t.textMuted}`}>Use @AI to chat with the assistant</p>
              </div>
            )}

            {messages.map((message) => (
              <div key={message.id} className={`flex gap-3 ${message.isBot ? 'bg-indigo-500/5 -mx-4 px-4 py-3 rounded-lg' : ''}`}>
                <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm flex-shrink-0 ${message.isBot ? 'bg-gradient-to-br from-purple-500 to-indigo-600' : ''}`} style={!message.isBot ? { backgroundColor: onlineUsers.find(u => u.name === message.userName)?.color || '#4b5563' } : undefined}>
                  {message.isBot ? '🤖' : onlineUsers.find(u => u.name === message.userName)?.avatar || message.userName.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className={`font-semibold text-sm ${message.isBot ? t.accentText : ''}`}>{message.userName}</span>
                    <span className={`text-xs ${t.textMuted}`}>{message.timestamp?.toDate?.()?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) || 'Now'}</span>
                  </div>
                  <p className={`${t.textSecondary} text-sm mt-1 whitespace-pre-wrap break-words leading-relaxed`}>{message.text}</p>
                  {message.fileName && (
                    <div className={`mt-2 inline-flex items-center gap-2 ${t.bgTertiary} rounded-lg px-3 py-2 text-sm`}>
                      <span>📄</span>
                      <span>{message.fileName}</span>
                      <span className={t.textMuted}>({formatFileSize(message.fileSize || 0)})</span>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {isTyping && (
              <div className="flex gap-3 items-center">
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center">🤖</div>
                <div className="flex gap-1">
                  {[0, 150, 300].map((delay) => (
                    <span key={delay} className={`w-2 h-2 ${resolvedTheme === 'dark' ? 'bg-zinc-500' : 'bg-stone-400'} rounded-full animate-bounce`} style={{ animationDelay: `${delay}ms` }} />
                  ))}
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Message Input */}
          <form onSubmit={sendMessage} className={`p-4 border-t ${t.border} ${t.bgSecondary} flex-shrink-0`}>
            <div className="flex gap-2">
              <input type="file" ref={chatFileInputRef} onChange={handleChatFileUpload} className="hidden" accept=".txt,.js,.ts,.jsx,.tsx,.py,.java,.c,.cpp,.css,.html,.json,.md" />
              <button type="button" onClick={() => chatFileInputRef.current?.click()} className="px-3 bg-gray-700/50 hover:bg-gray-700 text-gray-400 hover:text-white rounded-lg transition-all">📎</button>
              <input ref={messageInputRef} type="text" value={newMessage} onChange={(e) => setNewMessage(e.target.value)} className="flex-1 bg-gray-700/50 text-white rounded-lg px-4 py-2.5 border border-gray-600/50 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50 outline-none transition-all" placeholder={`Message #${activeChannel} (@AI for bot)`} />
              <button type="submit" disabled={!newMessage.trim()} className="px-5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-600 text-white font-medium rounded-lg transition-all">Send</button>
            </div>
          </form>
        </div>

        {/* Right Sidebar */}
        <div className={`w-72 ${t.bgSecondary} border-l ${t.border} flex flex-col flex-shrink-0`}>
          <div className={`flex border-b ${t.border} flex-shrink-0`}>
            {(['tasks', 'files', 'users', 'summary', 'ai'] as const).map((tab) => (
              <button key={tab} onClick={() => setRightPanelTab(tab)} className={`flex-1 py-2.5 text-xs font-medium transition-all ${rightPanelTab === tab ? 'text-indigo-400 border-b-2 border-indigo-400 bg-indigo-500/5' : 'text-gray-400 hover:text-gray-200'}`}>
                {tab === 'users' ? '👥' : tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto">
            {/* Tasks Tab */}
            {rightPanelTab === 'tasks' && (
              <div className="p-4">
                <form onSubmit={addTask} className="mb-4">
                  <div className="flex gap-2">
                    <input type="text" value={newTaskTitle} onChange={(e) => setNewTaskTitle(e.target.value)} className="flex-1 bg-gray-700/50 text-white rounded-lg px-3 py-2 border border-gray-600/50 text-sm" placeholder="Add task..." />
                    <button type="submit" disabled={!newTaskTitle.trim()} className="px-3 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-600 text-white rounded-lg">+</button>
                  </div>
                </form>

                <div className="flex gap-1 mb-4">
                  {(['all', 'active', 'completed'] as const).map((filter) => (
                    <button key={filter} onClick={() => setTaskFilter(filter)} className={`px-3 py-1 text-xs rounded-full transition-all ${taskFilter === filter ? 'bg-indigo-600 text-white' : 'bg-gray-700/50 text-gray-400 hover:text-white'}`}>
                      {filter.charAt(0).toUpperCase() + filter.slice(1)}
                    </button>
                  ))}
                </div>

                <div className="space-y-2">
                  {filteredTasks.length === 0 && <p className={`${t.textMuted} text-sm text-center py-8`}>No tasks</p>}
                  {filteredTasks.map((task) => (
                    <div key={task.id} className={`p-3 rounded-xl border transition-all ${task.completed ? `${t.bgTertiary} ${t.borderLight} opacity-60` : `${t.card} ${t.border}`}`}>
                      <div className="flex items-start gap-3">
                        <button onClick={() => toggleTask(task.id, task.completed)} className={`w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 mt-0.5 transition-all ${task.completed ? 'bg-green-600 border-green-600 text-white' : 'border-gray-500 hover:border-indigo-500'}`}>
                          {task.completed && '✓'}
                        </button>
                        <div className="flex-1 min-w-0">
                          <p className={`text-sm ${task.completed ? `${t.textMuted} line-through` : ''}`}>{task.title}</p>
                          <div className="flex items-center gap-2 mt-1.5">
                            <span className={`text-xs ${t.textMuted}`}>{task.createdBy}</span>
                            <select value={task.priority} onChange={(e) => updateTaskPriority(task.id, e.target.value as 'low' | 'medium' | 'high')} className={`text-xs px-2 py-0.5 rounded-full border-0 bg-transparent cursor-pointer ${task.priority === 'high' ? 'text-rose-500' : task.priority === 'medium' ? 'text-amber-500' : 'text-emerald-500'}`}>
                              <option value="low">Low</option>
                              <option value="medium">Medium</option>
                              <option value="high">High</option>
                            </select>
                          </div>
                        </div>
                        <button onClick={() => deleteTask(task.id)} className={`${t.textMuted} hover:text-rose-500 transition-colors`}>
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Users Tab */}
            {rightPanelTab === 'users' && (
              <div className="p-4">
                <h3 className={`text-sm font-semibold ${t.textSecondary} mb-3`}>Online ({onlineUsers.length})</h3>
                {onlineUsers.length === 0 ? (
                  <div className="text-center py-12">
                    <div className={`w-14 h-14 mx-auto mb-3 rounded-2xl ${t.bgTertiary} flex items-center justify-center`}>
                      <span className="text-2xl">👥</span>
                    </div>
                    <p className={`text-sm ${t.textMuted}`}>No one else online</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {onlineUsers.map((u) => (
                      <div key={u.id} className={`flex items-center gap-3 p-3 rounded-xl ${t.card} border ${t.borderLight}`}>
                        <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg relative shadow-sm" style={{ backgroundColor: u.color }}>
                          {u.avatar}
                          <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 ${resolvedTheme === 'dark' ? 'border-zinc-800' : 'border-white'} ${u.status === 'online' ? 'bg-emerald-500' : u.status === 'away' ? 'bg-amber-500' : 'bg-rose-500'}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium truncate">{u.name}</span>
                            {u.isVPN && <span className="w-2 h-2 rounded-full bg-emerald-500" title="VPN" />}
                          </div>
                          <span className={`text-xs ${t.textMuted} capitalize`}>{u.status}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Files Tab */}
            {rightPanelTab === 'files' && (
              <div className="p-4">
                <h3 className={`text-sm font-semibold ${t.textSecondary} mb-3`}>Files in #{activeChannel}</h3>
                {channelFiles.length === 0 ? (
                  <div className="text-center py-12">
                    <div className={`w-14 h-14 mx-auto mb-3 rounded-2xl ${t.bgTertiary} flex items-center justify-center`}>
                      <span className="text-2xl">📁</span>
                    </div>
                    <p className={`text-sm ${t.textMuted}`}>No files shared</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {channelFiles.map((file) => (
                      <div key={file.id} className={`p-3 ${t.card} border ${t.borderLight} rounded-xl`}>
                        <div className="flex items-start gap-3">
                          <div className={`w-10 h-10 rounded-lg ${t.bgTertiary} flex items-center justify-center`}>
                            <span>📄</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{file.fileName}</p>
                            <p className={`text-xs ${t.textMuted}`}>{formatFileSize(file.fileSize)} • {file.uploadedBy}</p>
                          </div>
                          <button onClick={() => deleteSharedFile(file.id)} className={`${t.textMuted} hover:text-rose-500`}>
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                          </button>
                        </div>
                        {file.content && (
                          <details className="mt-2">
                            <summary className={`text-xs ${t.accentText} cursor-pointer`}>Preview</summary>
                            <pre className={`mt-2 p-2 ${t.bgTertiary} rounded-lg text-xs ${t.textMuted} overflow-auto max-h-32`}>{file.content.substring(0, 500)}{file.content.length > 500 && '...'}</pre>
                          </details>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Summary Tab */}
            {rightPanelTab === 'summary' && (
              <div className="p-4">
                {!aiSummary ? (
                  <div className="text-center py-12">
                    <div className={`w-14 h-14 mx-auto mb-3 rounded-2xl ${t.bgTertiary} flex items-center justify-center`}>
                      <span className="text-2xl">📊</span>
                    </div>
                    <p className={`text-sm ${t.textMuted}`}>Click "Summarize" to analyze</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className={`text-xs ${t.textMuted} text-center pb-2 border-b ${t.borderLight}`}>
                      Generated {aiSummary.timestamp.toLocaleTimeString()}
                    </div>
                    {[{ title: 'Decisions', items: aiSummary.decisions, color: 'emerald', icon: '✅' }, { title: 'To-Do', items: aiSummary.todos, color: 'amber', icon: '📋' }, { title: 'Pending', items: aiSummary.pending, color: 'orange', icon: '⏳' }].map(({ title, items, color, icon }) => (
                      <div key={title}>
                        <h3 className={`text-sm font-semibold text-${color}-500 mb-2 flex items-center gap-2`}>{icon} {title}</h3>
                        {items.length === 0 ? <p className={`text-sm ${t.textMuted}`}>None</p> : (
                          <ul className="space-y-1.5">
                            {items.map((item, i) => <li key={i} className={`text-sm ${t.textSecondary} pl-3 border-l-2 border-${color}-500/30`}>{item}</li>)}
                          </ul>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* AI Tab */}
            {rightPanelTab === 'ai' && (
              <div className="p-4 space-y-4">
                <input type="file" ref={fileInputRef} onChange={handleFileUpload} accept=".txt,.js,.ts,.py,.json,.md" className="hidden" />
                <button onClick={() => fileInputRef.current?.click()} className="w-full py-3 border-2 border-dashed border-gray-600 hover:border-indigo-500 rounded-lg text-gray-400 hover:text-indigo-400 flex items-center justify-center gap-2 transition-all">
                  📁 Upload for Analysis
                </button>
                {uploadedFileName && (
                  <div className={`flex items-center justify-between ${t.card} border ${t.borderLight} rounded-lg px-3 py-2`}>
                    <span className={`text-sm ${t.textSecondary} truncate`}>📄 {uploadedFileName}</span>
                    <button onClick={clearFile} className={`${t.textMuted} hover:text-rose-500 ml-2`}>×</button>
                  </div>
                )}
                <textarea value={fileContent} onChange={(e) => setFileContent(e.target.value)} className="w-full h-28 bg-gray-700/50 text-white rounded-lg p-3 border border-gray-600/50 font-mono text-sm resize-none" placeholder="Or paste code..." />
                <button onClick={summarizeFile} disabled={!fileContent.trim() || isAiLoading} className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-600 text-white rounded-lg transition-all">
                  {isAiLoading ? '⏳ Analyzing...' : '✨ Analyze'}
                </button>
                {fileSummary && (
                  <div className={`p-4 ${t.card} border ${t.borderLight} rounded-xl`}>
                    <h3 className={`text-sm font-semibold ${t.accentText} mb-2`}>Analysis</h3>
                    <p className={`text-sm ${t.textSecondary} whitespace-pre-wrap leading-relaxed`}>{fileSummary}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Command Palette Modal */}
      {showCommandPalette && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-start justify-center pt-[20vh] z-50" onClick={() => setShowCommandPalette(false)}>
          <div className={`${t.bgSecondary} rounded-2xl w-full max-w-md shadow-2xl border ${t.border} overflow-hidden`} onClick={e => e.stopPropagation()}>
            <div className={`p-4 border-b ${t.border}`}>
              <input type="text" value={commandSearch} onChange={(e) => setCommandSearch(e.target.value)} className={`w-full bg-transparent ${t.text} outline-none text-lg`} placeholder="Type a command..." autoFocus />
            </div>
            <div className="max-h-72 overflow-y-auto">
              {filteredCommands.map((cmd, i) => (
                <button key={i} onClick={cmd.action} className={`w-full px-4 py-3 flex items-center gap-3 ${t.bgHover} text-left transition-colors`}>
                  <span className="text-xl w-8 text-center">{cmd.icon}</span>
                  <span className={t.text}>{cmd.name}</span>
                </button>
              ))}
            </div>
            <div className={`p-3 border-t ${t.border} text-xs ${t.textMuted} text-center`}>
              <kbd className={`px-1.5 py-0.5 ${t.bgTertiary} rounded`}>ESC</kbd> to close
            </div>
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={() => setShowSettings(false)}>
          <div className={`${t.bgSecondary} rounded-2xl w-full max-w-md shadow-2xl border ${t.border} p-6`} onClick={e => e.stopPropagation()}>
            <h2 className="text-xl font-semibold mb-6">Settings</h2>

            <div className="space-y-6">
              <div className="flex justify-center">
                <div className="w-20 h-20 rounded-2xl flex items-center justify-center text-4xl shadow-lg" style={{ backgroundColor: userSettings.color }}>
                  {userSettings.avatar}
                </div>
              </div>

              <div>
                <label className={`block text-xs ${t.textMuted} mb-3 uppercase tracking-wide font-medium`}>Avatar</label>
                <div className="flex flex-wrap gap-2">
                  {AVATAR_OPTIONS.map((avatar) => (
                    <button key={avatar} onClick={() => setUserSettings(s => ({ ...s, avatar }))} className={`w-10 h-10 rounded-lg flex items-center justify-center text-xl transition-all ${userSettings.avatar === avatar ? 'bg-indigo-600 ring-2 ring-indigo-400' : 'bg-gray-700 hover:bg-gray-600'}`}>
                      {avatar}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className={`block text-xs ${t.textMuted} mb-3 uppercase tracking-wide font-medium`}>Color</label>
                <div className="flex flex-wrap gap-2">
                  {COLOR_OPTIONS.map((color) => (
                    <button key={color} onClick={() => setUserSettings(s => ({ ...s, color }))} className={`w-8 h-8 rounded-full transition-all ${userSettings.color === color ? 'ring-2 ring-offset-2 ' + (resolvedTheme === 'dark' ? 'ring-white ring-offset-zinc-900' : 'ring-stone-900 ring-offset-white') : 'hover:scale-110'}`} style={{ backgroundColor: color }} />
                  ))}
                </div>
              </div>

              <div>
                <label className={`block text-xs ${t.textMuted} mb-3 uppercase tracking-wide font-medium`}>Status</label>
                <div className="flex gap-2">
                  {(['online', 'away', 'busy'] as const).map((status) => (
                    <button key={status} onClick={() => setUserSettings(s => ({ ...s, status }))} className={`flex-1 py-2 rounded-lg text-sm transition-all ${userSettings.status === status ? 'bg-indigo-600 text-white' : 'bg-gray-700 text-gray-400'}`}>
                      {status === 'online' ? '🟢' : status === 'away' ? '🟡' : '🔴'} {status}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex gap-3 pt-4">
                <button onClick={() => setShowSettings(false)} className="flex-1 py-2 bg-gray-700 text-white rounded-lg">Cancel</button>
                <button onClick={saveSettings} className="flex-1 py-2 bg-indigo-600 text-white rounded-lg">Save</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;

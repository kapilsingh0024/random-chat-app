import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import legalText from './legal.js';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';
const TOKEN_KEY = 'random-chat-token';
const getStoredToken = () => localStorage.getItem(TOKEN_KEY) || '';

const STUN = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];
function staticIceServers() {
  const servers = [...STUN];
  const turnUrl = import.meta.env.VITE_TURN_SERVER;
  if (turnUrl) {
    servers.push({
      urls: turnUrl.split(',').map((u) => u.trim()).filter(Boolean),
      username: import.meta.env.VITE_TURN_USERNAME,
      credential: import.meta.env.VITE_TURN_PASSWORD,
    });
  }
  return servers;
}

const REPORT_REASONS = ['Harassment or abuse', 'Nudity or sexual content', 'Spam or scam', 'Looks under 18', 'Other'];
const MODE_LABEL = { text: 'Text', audio: 'Audio', video: 'Video', 'audio-video': 'Audio + Video' };

export default function App() {
  const [authMode, setAuthMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '', gender: 'male', ageConfirmed: false });
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(getStoredToken());
  const [status, setStatus] = useState('Idle');
  const [matchPreference, setMatchPreference] = useState('anyone');
  const [chatMode, setChatMode] = useState('text');
  const [sessionMode, setSessionMode] = useState('text');
  const [messages, setMessages] = useState([]);
  const [activeRoom, setActiveRoom] = useState(null);
  const [peer, setPeer] = useState(null);
  const [matchWaiting, setMatchWaiting] = useState(false);
  const [endedInfo, setEndedInfo] = useState('');
  const [view, setView] = useState('full'); // 'full' | 'mini'
  const [input, setInput] = useState('');
  const [localAudioMuted, setLocalAudioMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [remoteVideoReady, setRemoteVideoReady] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState(REPORT_REASONS[0]);
  const [reportAttach, setReportAttach] = useState(false);
  const [legalOpen, setLegalOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwMsg, setPwMsg] = useState('');
  const [resetToken, setResetToken] = useState(() => new URLSearchParams(window.location.search).get('reset') || '');

  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const mediaPromiseRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const localVideoRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const remoteStreamRef = useRef(null);
  const pendingIceCandidatesRef = useRef([]);
  const iceRef = useRef(staticIceServers());
  const userIdRef = useRef(null);
  const activeRoomRef = useRef(null);
  const messagesEndRef = useRef(null);

  // ---------- call helpers ----------
  const cleanupCall = () => {
    if (peerConnectionRef.current) { peerConnectionRef.current.close(); peerConnectionRef.current = null; }
    pendingIceCandidatesRef.current = [];
    remoteStreamRef.current = null;
    mediaPromiseRef.current = null;
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    setRemoteVideoReady(false);
    setCameraOn(false);
    setLocalAudioMuted(false);
  };

  // Everything about a chat disappears when the session ends.
  const wipeSession = () => {
    activeRoomRef.current = null;
    setActiveRoom(null);
    setPeer(null);
    setMessages([]);
    setInput('');
    setReportOpen(false);
    setReportAttach(false);
    cleanupCall();
  };

  const startLocalMedia = (mode) => {
    if (!mediaPromiseRef.current) {
      mediaPromiseRef.current = (async () => {
        const wantsVideo = mode === 'video' || mode === 'audio-video';
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: wantsVideo });
        localStreamRef.current = stream;
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
        setCameraOn(wantsVideo);
        setLocalAudioMuted(false);
        return stream;
      })().catch((error) => { mediaPromiseRef.current = null; throw error; });
    }
    return mediaPromiseRef.current;
  };

  const createPeerConnection = (roomId) => {
    if (peerConnectionRef.current) return peerConnectionRef.current;
    const pc = new RTCPeerConnection({ iceServers: iceRef.current });
    if (localStreamRef.current) localStreamRef.current.getTracks().forEach((t) => pc.addTrack(t, localStreamRef.current));

    pc.ontrack = (event) => {
      const [remoteStream] = event.streams;
      if (remoteStream) remoteStreamRef.current = remoteStream;
      else { remoteStreamRef.current ||= new MediaStream(); remoteStreamRef.current.addTrack(event.track); }
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStreamRef.current;
        remoteVideoRef.current.play().catch(() => {});
      }
      if (event.track.kind === 'video') setRemoteVideoReady(true);
    };
    pc.onicecandidate = (event) => {
      if (event.candidate && roomId) socketRef.current?.emit('webrtc:ice-candidate', { roomId, candidate: event.candidate });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') setStatus('Call connection failed. A TURN server may be needed on this network.');
    };
    peerConnectionRef.current = pc;
    return pc;
  };

  const flushPendingIceCandidates = async (pc) => {
    const list = pendingIceCandidatesRef.current;
    pendingIceCandidatesRef.current = [];
    await Promise.all(list.map((c) => pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})));
  };

  // ---------- socket ----------
  const logout = (message = 'Logged out') => {
    localStorage.removeItem(TOKEN_KEY);
    socketRef.current?.disconnect();
    socketRef.current = null;
    wipeSession();
    setMatchWaiting(false);
    setEndedInfo('');
    setUser(null);
    setToken('');
    setStatus(message);
  };

  const initSocket = (authToken) => {
    socketRef.current?.disconnect();
    const socket = io(API_URL, { autoConnect: true, transports: ['websocket'], auth: { token: authToken } });
    socketRef.current = socket;

    socket.on('connect', () => setStatus('Connected'));
    socket.on('connect_error', (error) => {
      if (/Invalid or inactive|token missing/i.test(error.message)) logout('Your session is no longer valid. Please log in again.');
      else setStatus('Connection problem. Retrying...');
    });
    socket.on('auth:kicked', ({ reason }) => logout(reason || 'You were disconnected.'));

    socket.on('match:waiting', (payload) => {
      setMatchWaiting(true);
      setEndedInfo('');
      setStatus(payload?.message || 'Waiting for a match...');
    });
    socket.on('match:error', ({ message }) => {
      setStatus(message || 'Unable to match');
      setMatchWaiting(false);
    });

    socket.on('match:matched', async (payload) => {
      setMatchWaiting(false);
      setEndedInfo('');
      activeRoomRef.current = payload.roomId;
      setActiveRoom(payload.roomId);
      setSessionMode(payload.mode);
      setPeer(payload.peer);
      setMessages([]);
      setRemoteVideoReady(false);
      setStatus(`Matched with ${payload.peer?.name}`);

      if (['audio', 'video', 'audio-video'].includes(payload.mode)) {
        try {
          await startLocalMedia(payload.mode);
          if (activeRoomRef.current !== payload.roomId) return;
          const pc = createPeerConnection(payload.roomId);
          if (payload.isOfferer) {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit('webrtc:offer', { roomId: payload.roomId, offer, mode: payload.mode });
          }
        } catch (error) {
          setStatus(error.name === 'NotAllowedError'
            ? 'Allow camera and microphone access to start the call.'
            : 'Could not start camera or microphone. Check device permissions.');
        }
      }
    });

    socket.on('chat:message', (message) => setMessages((cur) => [...cur, message]));

    socket.on('session:ended', ({ reason, endedByUserId }) => {
      wipeSession();
      const mine = endedByUserId && endedByUserId === userIdRef.current;
      if (mine && reason === 'next') return; // you skipped; a new search starts right away
      setMatchWaiting(false);
      setStatus('Session ended');
      setEndedInfo(
        reason === 'admin-ended' ? 'A moderator ended this chat.'
          : reason === 'blocked' ? 'User blocked. You will not be matched with them again.'
          : mine ? 'You ended the chat.'
          : reason === 'next' ? 'The other person moved on to the next chat.'
          : 'The other person left the chat.'
      );
    });

    socket.on('webrtc:offer', async ({ offer, roomId, mode }) => {
      if (roomId !== activeRoomRef.current) return;
      try {
        await startLocalMedia(mode || 'video');
        const pc = createPeerConnection(roomId);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        await flushPendingIceCandidates(pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc:answer', { roomId, answer });
      } catch (error) {
        setStatus('Could not connect video. Check camera permissions and network.');
      }
    });
    socket.on('webrtc:answer', async ({ answer, roomId }) => {
      const pc = peerConnectionRef.current;
      if (!pc || roomId !== activeRoomRef.current) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        await flushPendingIceCandidates(pc);
      } catch (e) { /* ignore stale answer */ }
    });
    socket.on('webrtc:ice-candidate', ({ candidate, roomId }) => {
      if (!candidate || roomId !== activeRoomRef.current) return;
      const pc = peerConnectionRef.current;
      if (pc?.remoteDescription) pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
      else pendingIceCandidatesRef.current.push(candidate);
    });
  };

  // ---------- actions ----------
  const toggleMute = () => {
    localStreamRef.current?.getAudioTracks().forEach((t) => { t.enabled = !t.enabled; });
    setLocalAudioMuted((c) => !c);
  };
  const toggleCamera = () => {
    localStreamRef.current?.getVideoTracks().forEach((t) => { t.enabled = !t.enabled; });
    setCameraOn((c) => !c);
  };
  const sendChatMessage = () => {
    if (!activeRoom || !input.trim()) return;
    socketRef.current.emit('chat:message', { roomId: activeRoom, text: input.trim() });
    setInput('');
  };
  const requestMatch = () => {
    if (!socketRef.current) return;
    setEndedInfo('');
    socketRef.current.emit('match:request', { preference: matchPreference, mode: chatMode });
    setStatus('Searching...');
    setMatchWaiting(true);
  };
  const stopSearching = () => {
    socketRef.current?.emit('match:cancel');
    setMatchWaiting(false);
    setStatus('Search stopped');
  };
  const nextPerson = () => {
    if (!activeRoom) { requestMatch(); return; }
    socketRef.current.emit('session:next', { roomId: activeRoom });
    setStatus('Finding another person...');
  };
  const endSession = () => { if (activeRoom) socketRef.current.emit('session:end', { roomId: activeRoom }); };
  const blockPeer = () => {
    if (!activeRoom || !window.confirm('Block this person? You will never be matched with them again.')) return;
    socketRef.current.emit('user:block', { roomId: activeRoom });
  };
  const submitReport = async () => {
    if (!peer) return;
    try {
      const response = await fetch(`${API_URL}/api/reports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          reportedUserId: peer.userId,
          reason: reportReason,
          messages: reportAttach ? messages.slice(-10).map((m) => ({ from: m.from, text: m.text })) : [],
        }),
      });
      const data = await response.json();
      setStatus(data.message || 'Report submitted.');
    } catch (error) {
      setStatus('Failed to submit report.');
    }
    setReportOpen(false);
    setReportAttach(false);
  };

  const handleAuthSubmit = async (event) => {
    event.preventDefault();
    if (authMode === 'signup' && !form.ageConfirmed) { setStatus('You must confirm that you are 18 or older.'); return; }
    const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/signup';
    const payload = authMode === 'login'
      ? { email: form.email, password: form.password }
      : { name: form.name, email: form.email, password: form.password, gender: form.gender, ageConfirmed: form.ageConfirmed };
    try {
      const response = await fetch(`${API_URL}${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Authentication failed.');
      localStorage.setItem(TOKEN_KEY, data.token);
      setToken(data.token); // the effect below loads the profile and opens the socket
      setStatus('Logging in...');
    } catch (error) {
      setStatus(error.message || 'Something went wrong');
    }
  };

  const submitPasswordChange = async (event) => {
    event.preventDefault();
    if (pw.next !== pw.confirm) { setPwMsg('The new passwords do not match.'); return; }
    try {
      const response = await fetch(`${API_URL}/api/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword: pw.current, newPassword: pw.next }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Could not change password.');
      localStorage.setItem(TOKEN_KEY, data.token);
      setToken(data.token);
      setPwOpen(false);
      setPw({ current: '', next: '', confirm: '' });
      setPwMsg('');
      setStatus('Password changed. Other devices were logged out.');
    } catch (error) {
      setPwMsg(error.message);
    }
  };

  const handleResetSubmit = async (event) => {
    event.preventDefault();
    try {
      const response = await fetch(`${API_URL}/api/auth/reset`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, password: form.password }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message);
      window.history.replaceState({}, '', window.location.pathname);
      setResetToken('');
      setAuthMode('login');
      setForm({ ...form, password: '' });
      setStatus(data.message);
    } catch (error) {
      setStatus(error.message || 'Could not reset password.');
    }
  };

  // ---------- effects ----------
  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${API_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
        const data = await response.json();
        if (cancelled) return;
        if (!response.ok) { logout(data.message || 'Please log in again.'); return; }
        userIdRef.current = data.user.id;
        setUser(data.user);
        setMatchPreference(data.user.matchPreference || 'anyone');
        try { // optional time-limited TURN credentials from the backend
          const ice = await (await fetch(`${API_URL}/api/ice`, { headers: { Authorization: `Bearer ${token}` } })).json();
          if (ice.iceServers?.length) iceRef.current = [...STUN, ...ice.iceServers];
        } catch (e) { /* keep static servers */ }
        initSocket(token);
      } catch (error) {
        console.error(error);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  useEffect(() => {
    if (localVideoRef.current && localStreamRef.current) localVideoRef.current.srcObject = localStreamRef.current;
    if (remoteVideoRef.current && remoteStreamRef.current) {
      remoteVideoRef.current.srcObject = remoteStreamRef.current;
      remoteVideoRef.current.play().catch(() => {});
    }
  }, [activeRoom, view, remoteVideoReady]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ block: 'end' }); }, [messages, view]);

  const windowOpen = !!(activeRoom || matchWaiting || endedInfo);
  useEffect(() => {
    document.body.style.overflow = windowOpen && view === 'full' ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [windowOpen, view]);

  useEffect(() => () => {
    socketRef.current?.disconnect();
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  // ---------- UI ----------
  const legalModal = legalOpen && (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-slate-700 bg-slate-900">
        <pre className="flex-1 overflow-y-auto whitespace-pre-wrap p-5 font-sans text-sm leading-relaxed text-slate-200">{legalText}</pre>
        <div className="border-t border-slate-700 p-3 text-right">
          <button className="bg-cyan-500 text-slate-950" onClick={() => setLegalOpen(false)}>Close</button>
        </div>
      </div>
    </div>
  );

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="mx-auto w-full max-w-md rounded-3xl border border-slate-700 bg-slate-900/80 p-8 shadow-2xl">
          <div className="mb-6 text-center">
            <h1 className="text-3xl font-bold text-cyan-400">Random Chat</h1>
            <p className="mt-2 text-sm text-slate-300">Meet strangers safely and respectfully.</p>
          </div>

          {resetToken ? (
            <form className="space-y-4" onSubmit={handleResetSubmit}>
              <h2 className="text-lg font-semibold">Choose a new password</h2>
              <input type="password" placeholder="New password (8+ characters)" minLength={8} required
                value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              <button type="submit" className="w-full bg-cyan-500 text-slate-950 hover:bg-cyan-400">Save password</button>
            </form>
          ) : (
            <>
              <div className="mb-4 flex rounded-xl bg-slate-800 p-1">
                {['login', 'signup'].map((m) => (
                  <button key={m} type="button" className={`flex-1 ${authMode === m ? 'bg-cyan-500 text-slate-950' : 'text-slate-300'}`} onClick={() => setAuthMode(m)}>
                    {m === 'login' ? 'Login' : 'Signup'}
                  </button>
                ))}
              </div>
              <form className="space-y-4" onSubmit={handleAuthSubmit}>
                {authMode === 'signup' && (
                  <>
                    <input placeholder="Display name" maxLength={40} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                    <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })}
                      className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100">
                      <option value="male">Male</option>
                      <option value="female">Female</option>
                    </select>
                  </>
                )}
                <input type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                <input type="password" placeholder="Password (8+ characters)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                {authMode === 'signup' && (
                  <label className="flex items-start gap-2 text-sm text-slate-300">
                    <input type="checkbox" className="mt-1 !w-auto" checked={form.ageConfirmed} onChange={() => setForm({ ...form, ageConfirmed: !form.ageConfirmed })} />
                    <span>I am 18+ and I accept the{' '}
                      <button type="button" className="!p-0 text-cyan-400 underline" onClick={() => setLegalOpen(true)}>Terms &amp; Privacy Policy</button>.
                    </span>
                  </label>
                )}
                <button type="submit" className="w-full bg-cyan-500 text-slate-950 hover:bg-cyan-400">
                  {authMode === 'login' ? 'Login' : 'Create account'}
                </button>
              </form>
            </>
          )}
          <p className="mt-4 text-center text-xs text-slate-400" role="status">{status}</p>
        </div>
        {legalModal}
      </div>
    );
  }

  // ----- chat window (same elements in both sizes so video never restarts when resizing) -----
  const full = view === 'full';
  const hasMedia = sessionMode !== 'text';
  const hasVideo = sessionMode === 'video' || sessionMode === 'audio-video';
  const btn = full ? 'px-4 py-2 text-sm' : 'px-2.5 py-1.5 text-xs';
  const shell = full
    ? 'fixed inset-0 z-50 flex flex-col bg-slate-950'
    : 'fixed bottom-3 right-3 z-50 flex max-h-[calc(100vh-1.5rem)] w-[21rem] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-2xl border border-slate-600 bg-slate-950 shadow-2xl';

  const messageList = (
    <>
      {messages.length === 0 && <p className="text-sm text-slate-300">Say hi. Messages exist only during this chat and are erased when it ends.</p>}
      {messages.map((m, i) => (
        <div key={`${m.timestamp}-${i}`} className="mb-1.5 w-fit max-w-full rounded-lg bg-slate-800/90 px-3 py-1.5 text-sm">
          <span className="font-semibold text-cyan-400">{m.from === user.id ? 'You' : peer?.name || 'Stranger'}:</span> {m.text}
        </div>
      ))}
      <div ref={messagesEndRef} />
    </>
  );

  const chatWindow = windowOpen && (
    <div className={shell}>
      <div className="flex items-center justify-between gap-2 border-b border-slate-700 bg-slate-900 px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">
            {activeRoom ? (peer?.name || 'Stranger') : matchWaiting ? 'Looking for someone...' : 'Chat ended'}
          </p>
          {activeRoom && <p className="text-xs text-slate-400">{MODE_LABEL[sessionMode]}</p>}
        </div>
        <button className={`${btn} bg-slate-700 text-slate-100 hover:bg-slate-600`} onClick={() => setView(full ? 'mini' : 'full')}>
          {full ? 'Mini screen' : 'Full screen'}
        </button>
      </div>

      {activeRoom ? (
        <>
          {hasMedia && (
            <div className={`relative bg-black ${full ? 'min-h-0 flex-1' : 'h-40 shrink-0'}`}>
              <video ref={remoteVideoRef} autoPlay playsInline className={`absolute inset-0 h-full w-full object-cover ${hasVideo ? '' : 'opacity-0'}`} />
              {(!hasVideo || !remoteVideoReady) && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-slate-300">
                  {hasVideo ? "Waiting for the stranger's camera..." : `Voice call with ${peer?.name || 'Stranger'}`}
                </div>
              )}
              {hasVideo && (
                <video ref={localVideoRef} autoPlay muted playsInline
                  className={`absolute right-2 top-2 rounded-lg border border-slate-500 bg-slate-900 object-cover ${full ? 'w-28 sm:w-44' : 'w-20'}`} />
              )}
              {full && (
                <div className="absolute inset-x-0 bottom-0 max-h-[45%] overflow-y-auto bg-gradient-to-t from-black/80 to-transparent p-3">
                  {messageList}
                </div>
              )}
            </div>
          )}
          {(!hasMedia || !full) && (
            <div className={`overflow-y-auto bg-slate-950 p-3 ${full ? 'min-h-0 flex-1' : hasMedia ? 'h-28 shrink-0' : 'h-52 shrink-0'}`}>
              {messageList}
            </div>
          )}

          <div className="space-y-2 border-t border-slate-700 bg-slate-900 p-2">
            <div className="flex min-w-0 gap-2">
              <input className="min-w-0 flex-1" value={input} maxLength={500} placeholder="Type a message"
                onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') sendChatMessage(); }} />
              <button className={`${btn} shrink-0 bg-cyan-500 text-slate-950 hover:bg-cyan-400`} onClick={sendChatMessage}>Send</button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {hasMedia && <button className={`${btn} bg-slate-700 hover:bg-slate-600`} onClick={toggleMute}>{localAudioMuted ? 'Unmute' : 'Mute'}</button>}
              {hasVideo && <button className={`${btn} bg-slate-700 hover:bg-slate-600`} onClick={toggleCamera}>{cameraOn ? 'Camera off' : 'Camera on'}</button>}
              <button className={`${btn} bg-cyan-500 text-slate-950 hover:bg-cyan-400`} onClick={nextPerson}>Next</button>
              <button className={`${btn} bg-rose-600 hover:bg-rose-500`} onClick={endSession}>Stop</button>
              <button className={`${btn} bg-red-500 hover:bg-red-400`} onClick={() => setReportOpen(true)}>Report</button>
              <button className={`${btn} bg-orange-500 hover:bg-orange-400`} onClick={blockPeer}>Block</button>
            </div>
          </div>
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
          {matchWaiting ? (
            <>
              <p className="text-slate-200">Looking for someone to chat with...</p>
              <button className="bg-rose-600 hover:bg-rose-500" onClick={stopSearching}>Stop searching</button>
            </>
          ) : (
            <>
              <p className="text-slate-200">{endedInfo}</p>
              <p className="text-xs text-slate-400">The chat has been deleted.</p>
              <div className="flex gap-2">
                <button className="bg-cyan-500 text-slate-950 hover:bg-cyan-400" onClick={requestMatch}>Find next person</button>
                <button className="bg-slate-700 hover:bg-slate-600" onClick={() => setEndedInfo('')}>Close</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );

  const reportModal = reportOpen && (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-sm space-y-3 rounded-2xl border border-slate-700 bg-slate-900 p-5">
        <h3 className="text-lg font-semibold">Report {peer?.name}</h3>
        <select value={reportReason} onChange={(e) => setReportReason(e.target.value)}
          className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100">
          {REPORT_REASONS.map((r) => <option key={r}>{r}</option>)}
        </select>
        <label className="flex items-start gap-2 text-sm text-slate-300">
          <input type="checkbox" className="mt-1 !w-auto" checked={reportAttach} onChange={() => setReportAttach(!reportAttach)} />
          <span>Attach the last few messages of this chat to the report (optional)</span>
        </label>
        <div className="flex justify-end gap-2">
          <button className="bg-slate-700 hover:bg-slate-600" onClick={() => setReportOpen(false)}>Cancel</button>
          <button className="bg-red-500 hover:bg-red-400" onClick={submitReport}>Send report</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen p-3 text-slate-100 sm:p-6">
      <div className="mx-auto max-w-3xl">
        <header className="mb-6 flex flex-col gap-4 rounded-2xl border border-slate-700 bg-slate-900/80 p-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm text-slate-400">Welcome back</p>
            <h2 className="text-2xl font-bold">{user.name}</h2>
          </div>
          <div className="flex items-center gap-3">
            <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-xs text-emerald-300" role="status">{status}</span>
            <button className="bg-slate-700 text-slate-100 hover:bg-slate-600" disabled={!!activeRoom}
              title={activeRoom ? 'Finish your chat first' : ''} onClick={() => { setPwMsg(''); setPwOpen(true); }}>Change password</button>
            <button className="bg-slate-700 text-slate-100 hover:bg-slate-600" onClick={() => logout()}>Logout</button>
          </div>
        </header>

        <section className="rounded-2xl border border-slate-700 bg-slate-900/80 p-5">
          <h3 className="mb-4 text-xl font-semibold">Start a chat</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm text-slate-300">Who do you want to chat with?</label>
              <select value={matchPreference} onChange={(e) => setMatchPreference(e.target.value)}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100">
                <option value="anyone">Anyone</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm text-slate-300">Mode (text chat is always available)</label>
              <select value={chatMode} onChange={(e) => setChatMode(e.target.value)}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100">
                {Object.entries(MODE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          </div>
          <button className="mt-5 w-full bg-cyan-500 text-slate-950 hover:bg-cyan-400" onClick={requestMatch} disabled={matchWaiting || !!activeRoom}>
            {matchWaiting ? 'Searching...' : activeRoom ? 'In a chat' : 'Start matching'}
          </button>
          {windowOpen && !full && <p className="mt-3 text-xs text-slate-400">Your chat is open in the mini window. Use "Full screen" to enlarge it.</p>}
          <p className="mt-4 text-xs text-slate-400">
            Chats are never saved: they disappear as soon as the session ends. Reported or live sessions may be reviewed by moderators.{' '}
            <button type="button" className="!p-0 text-cyan-400 underline" onClick={() => setLegalOpen(true)}>Terms &amp; Privacy</button>
          </p>
        </section>
      </div>
      {pwOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4">
          <form onSubmit={submitPasswordChange} className="w-full max-w-sm space-y-3 rounded-2xl border border-slate-700 bg-slate-900 p-5">
            <h3 className="text-lg font-semibold">Change password</h3>
            <input type="password" placeholder="Current password" required autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
            <input type="password" placeholder="New password (8+ characters)" required minLength={8} autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
            <input type="password" placeholder="Repeat new password" required minLength={8} autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
            {pwMsg && <p className="text-sm text-rose-300" role="alert">{pwMsg}</p>}
            <p className="text-xs text-slate-400">You will stay logged in here; all your other devices are logged out.</p>
            <div className="flex justify-end gap-2">
              <button type="button" className="bg-slate-700 hover:bg-slate-600" onClick={() => setPwOpen(false)}>Cancel</button>
              <button type="submit" className="bg-cyan-500 text-slate-950 hover:bg-cyan-400">Save</button>
            </div>
          </form>
        </div>
      )}
      {chatWindow}
      {reportModal}
      {legalModal}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

const getStoredToken = () => localStorage.getItem('random-chat-token') || '';

export default function App() {
  const [authMode, setAuthMode] = useState('login');
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    gender: 'male',
    ageConfirmed: false,
  });
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(getStoredToken());
  const [status, setStatus] = useState('Idle');
  const [matchPreference, setMatchPreference] = useState('anyone');
  const [chatMode, setChatMode] = useState('text');
  const [messages, setMessages] = useState([]);
  const [activeRoom, setActiveRoom] = useState(null);
  const [peer, setPeer] = useState(null);
  const [matchWaiting, setMatchWaiting] = useState(false);
  const [input, setInput] = useState('');
  const [localAudioMuted, setLocalAudioMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [blocked, setBlocked] = useState(false);

  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const localVideoRef = useRef(null);
  const peerConnectionRef = useRef(null);

  const csr = useMemo(() => {
    return { stun: { urls: 'stun:stun.l.google.com:19302' } };
  }, []);

  const initSocket = (authToken) => {
    if (socketRef.current) {
      socketRef.current.disconnect();
    }

    const socket = io(API_URL, {
      autoConnect: true,
      transports: ['websocket'],
      auth: { token: authToken },
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setStatus('Connected');
    });

    socket.on('match:waiting', (payload) => {
      setMatchWaiting(true);
      setStatus(payload?.message || 'Waiting for a match...');
    });

    socket.on('match:matched', async (payload) => {
      setMatchWaiting(false);
      setActiveRoom(payload.roomId);
      setPeer(payload.peer);
      setStatus(`Matched with ${payload.peer?.name}`);
      setMessages([]);

      if (['audio', 'video', 'audio-video'].includes(payload.mode)) {
        await startLocalMedia(payload.mode);
        await createPeerConnection();
        const pc = peerConnectionRef.current;
        if (pc) {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('webrtc:offer', { roomId: payload.roomId, offer });
        }
      }
    });

    socket.on('chat:message', (message) => {
      setMessages((current) => [...current, message]);
    });

    socket.on('session:ended', ({ roomId, reason }) => {
      setStatus(`Session ended (${reason})`);
      setActiveRoom(null);
      setPeer(null);
      setMessages([]);
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
      }
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
        localStreamRef.current = null;
      }
      if (localVideoRef.current) localVideoRef.current.srcObject = null;
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    });

    socket.on('webrtc:offer', async ({ offer, from }) => {
      await createPeerConnection();
      const pc = peerConnectionRef.current;
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('webrtc:answer', { roomId: activeRoom, answer });
    });

    socket.on('webrtc:answer', async ({ answer }) => {
      const pc = peerConnectionRef.current;
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    });

    socket.on('webrtc:ice-candidate', ({ candidate }) => {
      const pc = peerConnectionRef.current;
      if (pc && candidate) {
        pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
      }
    });

    socket.on('match:error', ({ message }) => {
      setStatus(message || 'Unable to match');
      setMatchWaiting(false);
    });

    socket.on('connect_error', () => {
      setStatus('Socket connection error');
    });
  };

  const createPeerConnection = async () => {
    if (peerConnectionRef.current) return peerConnectionRef.current;

    const pc = new RTCPeerConnection({ iceServers: [csr.stun] });

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => pc.addTrack(track, localStreamRef.current));
    }

    pc.ontrack = (event) => {
      const remoteStream = event.streams[0];
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream;
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && activeRoom) {
        socketRef.current.emit('webrtc:ice-candidate', { roomId: activeRoom, candidate: event.candidate });
      }
    };

    peerConnectionRef.current = pc;
    return pc;
  };

  const startLocalMedia = async (mode) => {
    if (localStreamRef.current) {
      if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
      return localStreamRef.current;
    }

    const constraints = {
      audio: true,
      video: mode === 'video' || mode === 'audio-video',
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    localStreamRef.current = stream;

    if (localVideoRef.current) localVideoRef.current.srcObject = stream;
    if (peerConnectionRef.current) {
      stream.getTracks().forEach((track) => peerConnectionRef.current.addTrack(track, stream));
    }

    setCameraOn(mode === 'video' || mode === 'audio-video');
    return stream;
  };

  const toggleMute = () => {
    if (!localStreamRef.current) return;
    const audioTracks = localStreamRef.current.getAudioTracks();
    audioTracks.forEach((track) => {
      track.enabled = !track.enabled;
    });
    setLocalAudioMuted((current) => !current);
  };

  const toggleCamera = () => {
    if (!localStreamRef.current) return;
    const videoTracks = localStreamRef.current.getVideoTracks();
    videoTracks.forEach((track) => {
      track.enabled = !track.enabled;
    });
    setCameraOn((current) => !current);
  };

  const sendChatMessage = () => {
    if (!activeRoom || !input.trim()) return;
    socketRef.current.emit('chat:message', { roomId: activeRoom, text: input.trim() });
    setInput('');
  };

  const requestMatch = () => {
    if (!socketRef.current) return;
    socketRef.current.emit('match:request', {
      preference: matchPreference,
      mode: chatMode,
    });
    setStatus('Searching...');
    setMatchWaiting(true);
  };

  const leaveSession = (reason = 'ended') => {
    if (!activeRoom) return;
    socketRef.current.emit('session:end', { roomId: activeRoom, reason });
  };

  const nextPerson = () => {
    if (!activeRoom) {
      requestMatch();
      return;
    }
    socketRef.current.emit('session:next', { roomId: activeRoom });
    setStatus('Finding another person...');
  };

  const handleReport = async () => {
    if (!peer) return;
    try {
      const response = await fetch(`${API_URL}/api/reports`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          reportedUserId: peer.userId,
          reason: 'Inappropriate behavior',
          messageSnippet: messages.slice(-3).map((message) => message.text).join(' | '),
        }),
      });
      const data = await response.json();
      setStatus(data.message || 'Report submitted.');
    } catch (error) {
      setStatus('Failed to submit report.');
    }
  };

  const handleBlock = () => {
    setBlocked(true);
    setStatus('User blocked from future matches.');
  };

  const handleAuthSubmit = async (event) => {
    event.preventDefault();

    if (authMode === 'signup' && !form.ageConfirmed) {
      setStatus('You must confirm that you are 18 or older.');
      return;
    }

    const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/signup';

    const payload = authMode === 'login'
      ? { email: form.email, password: form.password }
      : {
          name: form.name,
          email: form.email,
          password: form.password,
          gender: form.gender,
          ageConfirmed: form.ageConfirmed,
        };

    try {
      const response = await fetch(`${API_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || 'Authentication failed.');
      }

      localStorage.setItem('random-chat-token', data.token);
      setToken(data.token);
      setUser(data.user);
      initSocket(data.token);
      setStatus('Logged in');
    } catch (error) {
      setStatus(error.message || 'Something went wrong');
    }
  };

  useEffect(() => {
    if (!token) return;

    const fetchUser = async () => {
      try {
        const response = await fetch(`${API_URL}/api/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await response.json();
        if (response.ok) {
          setUser(data.user);
          initSocket(token);
        } else {
          localStorage.removeItem('random-chat-token');
          setToken('');
        }
      } catch (error) {
        console.error(error);
      }
    };

    fetchUser();
  }, [token]);

  useEffect(() => {
    return () => {
      if (socketRef.current) socketRef.current.disconnect();
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  const renderAuth = () => (
    <div className="mx-auto max-w-md rounded-3xl border border-slate-700 bg-slate-900/80 p-8 shadow-2xl">
      <div className="mb-6 text-center">
        <h1 className="text-3xl font-bold text-cyan-400">Random Chat</h1>
        <p className="mt-2 text-sm text-slate-300">Meet strangers safely and respectfully.</p>
      </div>

      <div className="mb-4 flex rounded-xl bg-slate-800 p-1">
        <button
          type="button"
          className={`flex-1 ${authMode === 'login' ? 'bg-cyan-500 text-slate-950' : 'text-slate-300'}`}
          onClick={() => setAuthMode('login')}
        >
          Login
        </button>
        <button
          type="button"
          className={`flex-1 ${authMode === 'signup' ? 'bg-cyan-500 text-slate-950' : 'text-slate-300'}`}
          onClick={() => setAuthMode('signup')}
        >
          Signup
        </button>
      </div>

      <form className="space-y-4" onSubmit={handleAuthSubmit}>
        {authMode === 'signup' && (
          <>
            <input
              placeholder="Full name"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
            <select
              value={form.gender}
              onChange={(event) => setForm({ ...form, gender: event.target.value })}
              className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
            >
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </>
        )}

        <input
          type="email"
          placeholder="Email"
          value={form.email}
          onChange={(event) => setForm({ ...form, email: event.target.value })}
        />
        <input
          type="password"
          placeholder="Password"
          value={form.password}
          onChange={(event) => setForm({ ...form, password: event.target.value })}
        />

        {authMode === 'signup' && (
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={form.ageConfirmed}
              onChange={() => setForm({ ...form, ageConfirmed: !form.ageConfirmed })}
            />
            I am 18+
          </label>
        )}

        <button type="submit" className="w-full bg-cyan-500 text-slate-950 hover:bg-cyan-400">
          {authMode === 'login' ? 'Login' : 'Create account'}
        </button>
      </form>
      <p className="mt-4 text-center text-xs text-slate-400">{status}</p>
    </div>
  );

  if (!user) return <div className="flex min-h-screen items-center justify-center p-6">{renderAuth()}</div>;

  return (
    <div className="min-h-screen p-6 text-slate-100">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6 flex flex-col gap-4 rounded-2xl border border-slate-700 bg-slate-900/80 p-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm text-slate-400">Welcome back</p>
            <h2 className="text-2xl font-bold">{user.name}</h2>
          </div>
          <div className="flex items-center gap-3">
            <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-xs text-emerald-300">{status}</span>
            <button
              className="bg-slate-700 text-slate-100 hover:bg-slate-600"
              onClick={() => {
                localStorage.removeItem('random-chat-token');
                setUser(null);
                setToken('');
                setStatus('Logged out');
                if (socketRef.current) socketRef.current.disconnect();
              }}
            >
              Logout
            </button>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
          <aside className="rounded-2xl border border-slate-700 bg-slate-900/80 p-5">
            <h3 className="mb-4 text-xl font-semibold">Preferences</h3>
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm text-slate-300">Who do you want to chat with?</label>
                <select
                  value={matchPreference}
                  onChange={(event) => setMatchPreference(event.target.value)}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                >
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                  <option value="anyone">Anyone</option>
                </select>
              </div>

              <div>
                <label className="mb-1 block text-sm text-slate-300">Mode</label>
                <select
                  value={chatMode}
                  onChange={(event) => setChatMode(event.target.value)}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                >
                  <option value="text">Text</option>
                  <option value="audio">Audio</option>
                  <option value="video">Video</option>
                  <option value="audio-video">Audio + Video</option>
                </select>
              </div>

              <button className="w-full bg-cyan-500 text-slate-950 hover:bg-cyan-400" onClick={requestMatch}>
                {matchWaiting ? 'Searching...' : 'Start matching'}
              </button>
              <button className="w-full bg-slate-700 text-slate-100 hover:bg-slate-600" onClick={nextPerson}>
                Next
              </button>
            </div>
          </aside>

          <main className="rounded-2xl border border-slate-700 bg-slate-900/80 p-5">
            {activeRoom ? (
              <>
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <p className="text-sm text-slate-400">Connected with</p>
                    <h3 className="text-xl font-semibold">{peer?.name || 'Stranger'}</h3>
                  </div>
                  <div className="flex gap-2">
                    <button className="bg-red-500 hover:bg-red-400" onClick={handleReport}>Report</button>
                    <button className="bg-orange-500 hover:bg-orange-400" onClick={handleBlock} disabled={blocked}>
                      {blocked ? 'Blocked' : 'Block'}
                    </button>
                    <button className="bg-slate-700 hover:bg-slate-600" onClick={nextPerson}>Next</button>
                    <button className="bg-rose-600 hover:bg-rose-500" onClick={() => leaveSession('ended')}>End</button>
                  </div>
                </div>

                {(chatMode === 'audio' || chatMode === 'video' || chatMode === 'audio-video') && (
                  <div className="mb-5 grid gap-4 md:grid-cols-2">
                    <div className="relative overflow-hidden rounded-xl border border-slate-700 bg-slate-950 p-2">
                      <video ref={localVideoRef} autoPlay muted playsInline className="h-52 w-full rounded-lg object-cover" />
                    </div>
                    <div className="relative overflow-hidden rounded-xl border border-slate-700 bg-slate-950 p-2">
                      <video ref={remoteVideoRef} autoPlay playsInline className="h-52 w-full rounded-lg object-cover" />
                    </div>
                  </div>
                )}

                <div className="mb-3 flex gap-2">
                  <button className="bg-slate-700 text-slate-100 hover:bg-slate-600" onClick={toggleMute}>
                    {localAudioMuted ? 'Unmute audio' : 'Mute audio'}
                  </button>
                  <button className="bg-slate-700 text-slate-100 hover:bg-slate-600" onClick={toggleCamera}>
                    {cameraOn ? 'Turn camera off' : 'Turn camera on'}
                  </button>
                </div>

                <div className="mb-3 h-64 overflow-y-auto rounded-2xl border border-slate-700 bg-slate-950/70 p-3">
                  {messages.length === 0 ? (
                    <p className="text-sm text-slate-400">Say hi. Messages are live only in this session.</p>
                  ) : (
                    messages.map((message, index) => (
                      <div key={`${message.timestamp || index}`} className="mb-2 rounded-lg bg-slate-800 px-3 py-2 text-sm">
                        <span className="font-semibold text-cyan-400">{message.from === user.id ? 'You' : 'Stranger'}:</span> {message.text}
                      </div>
                    ))
                  )}
                </div>

                <div className="flex gap-2">
                  <input
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    placeholder="Type a message"
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') sendChatMessage();
                    }}
                  />
                  <button className="bg-cyan-500 text-slate-950 hover:bg-cyan-400" onClick={sendChatMessage}>Send</button>
                </div>
              </>
            ) : (
              <div className="flex h-full min-h-[400px] items-center justify-center rounded-2xl border border-dashed border-slate-700 text-slate-400">
                {matchWaiting ? 'Waiting for a stranger...' : 'Start matching to begin a live chat'}
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

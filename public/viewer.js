const $ = id => document.getElementById(id);
const socket = io({ autoConnect: false });

// ICE config (uses ICE_SERVERS from ice.js if present, else Google STUN)
const iceConfig = (typeof ICE_SERVERS !== "undefined" && Array.isArray(ICE_SERVERS) && ICE_SERVERS.length)
    ? { iceServers: ICE_SERVERS }
    : { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

let pc = null;               // broadcast stream PC (host → viewer)
let hostId = null;           // socket id of the host sending us the stream
let currentRoom = null;
let myName = "Viewer-" + Math.floor(Math.random() * 1000);

// separate PC for 1-to-1 “on-stage” call
let callPc = null;
let localCallStream = null;

// ======================================================
// NEW: REAL-TIME HEALTH REPORTING (Professional Patch)
// ======================================================
let statsInterval = null;

function startStatsReporting(peer) {
    if (statsInterval) clearInterval(statsInterval);
    statsInterval = setInterval(async () => {
        if (!peer || peer.connectionState !== 'connected') return;

        const stats = await peer.getStats();
        stats.forEach(report => {
            if (report.type === 'inbound-rtp' && report.kind === 'video') {
                // Calculate latency based on jitter buffer delay
                const latency = Math.round((report.jitterBufferDelay / report.jitterBufferEmittedCount) * 1000) || 0;
                
                // Update the Latency Badge in view.html
                const badge = $('latencyBadge');
                const mirror = $('viewerStatusMirror');
                if (badge) {
                    badge.innerHTML = `⏱️ ${latency}ms`;
                    badge.style.display = 'inline-block';
                    badge.style.color = latency > 200 ? '#ff4b6a' : '#9ba3c0';
                }
                if (mirror) mirror.innerHTML = `${latency}ms`;

                // Send latency back to the host via the server stats listener
                socket.emit('report-stats', { latency });
            }
        });
    }, 2000);
}

// ======================================================
// 1. ARCADE RECEIVER (P2P game/tool file from host)
// ======================================================
function setupReceiver(pcInstance) {
    pcInstance.ondatachannel = (e) => {
        if (e.channel.label !== "side-load-pipe") return;

        const chan = e.channel;
        let chunks = [];
        let meta = null;
        let received = 0;

        chan.onmessage = (evt) => {
            if (!meta && typeof evt.data === "string") {
                try {
                    const parsed = JSON.parse(evt.data);
                    if (parsed && parsed.type === "meta") {
                        meta = parsed;
                        received = 0;
                        chunks = [];
                        console.log("[Arcade] Receiving:", meta.name, meta.size);
                        return;
                    }
                } catch (err) {
                    console.warn("[Arcade] Bad meta", err);
                }
                return;
            }

            if (!meta) return;

            chunks.push(evt.data);
            received += evt.data.byteLength || evt.data.size || 0;

            if (received >= meta.size) {
                const blob = new Blob(chunks, {
                    type: meta.mime || "application/octet-stream"
                });
                const url = URL.createObjectURL(blob);

                const toolbox = $("toolboxContainer");
                if (toolbox) {
                    const card = document.createElement("div");
                    card.className = "toolbox-card";

                    const title = document.createElement("div");
                    title.className = "toolbox-title";
                    title.textContent = meta.name || "Tool";

                    const actions = document.createElement("div");
                    actions.className = "toolbox-actions";

                    const a = document.createElement("a");
                    a.href = url;
                    a.download = meta.name || "download.bin";
                    a.className = "btn-ctrl pulse-primary"; // Added pulse-primary for high visibility
                    a.textContent = "Download";

                    actions.appendChild(a);
                    card.appendChild(title);
                    card.appendChild(actions);
                    toolbox.appendChild(card);
                }

                console.log("[Arcade] Complete:", meta.name);
                meta = null;
                chunks = [];
                received = 0;
                chan.close();
            }
        };
    };
}

// ======================================================
// 2. STREAM CONNECTION (host → viewer video)
// ======================================================
socket.on("connect", () => {
    const status = $("viewerStatus");
    if (status) status.textContent = "CONNECTED";
});

socket.on("disconnect", () => {
    const status = $("viewerStatus");
    if (status) {
        status.textContent = "OFFLINE";
        status.classList.remove('live');
    }
});

socket.on("webrtc-offer", async ({ sdp, from }) => {
    try {
        hostId = from;

        if (pc) {
            try { pc.close(); } catch (e) {}
            pc = null;
        }

        pc = new RTCPeerConnection(iceConfig);
        setupReceiver(pc);

        pc.ontrack = (e) => {
            const v = $("viewerVideo");
            if (!v) return;
            if (v.srcObject !== e.streams[0]) {
                v.srcObject = e.streams[0];
                v.play().catch(() => {});
            }
            const status = $("viewerStatus");
            if (status) {
                status.textContent = "LIVE";
                status.classList.add('live'); // Green indicator
            }
        };

        pc.onicecandidate = (e) => {
            if (e.candidate && hostId) {
                socket.emit("webrtc-ice-candidate", {
                    targetId: hostId,
                    candidate: e.candidate
                });
            }
        };

        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        socket.emit("webrtc-answer", {
            targetId: hostId,
            sdp: answer
        });

        // NEW: Initiate stats polling
        startStatsReporting(pc);

    } catch (err) {
        console.error("[Viewer] webrtc-offer failed", err);
    }
});

socket.on("webrtc-ice-candidate", async ({ candidate }) => {
    if (!pc || !candidate) return;
    try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
        console.error("[Viewer] addIceCandidate failed", err);
    }
});

// ======================================================
// 3. ON-STAGE CALL (host ↔ viewer 1-to-1 call)
// ======================================================
async function ensureLocalCallStream() {
    if (
        localCallStream &&
        localCallStream.getTracks().some(t => t.readyState === "live")
    ) {
        return;
    }

    // PATCH: Professional audio constraints for stage calls
    localCallStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { max: 30 } }
    });

    const prev = $("selfCamPreview");
    if (prev) {
        prev.srcObject = localCallStream;
        prev.muted = true;
        prev.play().catch(() => {});
    }
}

socket.on("ring-alert", async ({ from, fromId }) => {
    const ok = confirm(
        `Host ${from} wants to bring you on stage.\n\nAllow camera & mic?`
    );
    if (!ok) return;

    try {
        await ensureLocalCallStream();
        await startCallToHost(fromId);
    } catch (err) {
        console.error("[Viewer] stage call failed", err);
        alert("Could not access your camera/mic. Check permissions and try again.");
    }
});

async function startCallToHost(targetId) {
    if (!targetId) return;

    await ensureLocalCallStream();

    if (callPc) {
        try { callPc.close(); } catch (e) {}
        callPc = null;
    }

    const pc2 = new RTCPeerConnection(iceConfig);
    callPc = pc2;

    pc2.onicecandidate = (e) => {
        if (e.candidate) {
            socket.emit("call-ice", {
                targetId,
                candidate: e.candidate
            });
        }
    };

    pc2.ontrack = (e) => {
        console.log("[Viewer] host call track", e.streams[0]);
    };

    localCallStream.getTracks().forEach(t => pc2.addTrack(t, localCallStream));

    const offer = await pc2.createOffer();
    await pc2.setLocalDescription(offer);

    socket.emit("call-offer", {
        targetId,
        offer
    });
}

socket.on("call-answer", async ({ from, answer }) => {
    if (!callPc || !answer) return;
    try {
        await callPc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (err) {
        console.error("[Viewer] remote answer failed", err);
    }
});

socket.on("call-ice", async ({ from, candidate }) => {
    if (!callPc || !candidate) return;
    try {
        await callPc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
        console.error("[Viewer] call ICE failed", err);
    }
});

socket.on("call-end", ({ from }) => {
    if (callPc) {
        try { callPc.close(); } catch (e) {}
        callPc = null;
    }
});

// ======================================================
// 4. CHAT + SYSTEM MESSAGES
// ======================================================
function appendChat(name, text) {
    const log = $("chatLog");
    if (!log) return;

    const div = document.createElement("div");
    div.className = "chat-line";

    const strong = document.createElement("strong");
    strong.textContent = name;

    const span = document.createElement("span");
    span.textContent = `: ${text}`;

    div.appendChild(strong);
    div.appendChild(span);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
}

socket.on("public-chat", (d) => {
    appendChat(d.name, d.text);
});

socket.on("kicked", () => {
    alert("You have been kicked from the room by the host.");
    window.location.href = "index.html";
});

socket.on("room-error", (err) => {
    alert(err || "Room error");
    window.location.href = "index.html";
});

// ======================================================
// 5. UI WIRING (join room, chat, mute, fullscreen, etc.)
// ======================================================
function sendChat() {
    const input = $("chatInput");
    if (!input || !currentRoom) return;

    const text = input.value.trim();
    if (!text) return;

    socket.emit("public-chat", {
        room: currentRoom,
        name: myName,
        text,
        fromViewer: true
    });

    input.value = "";
}

window.addEventListener("load", () => {
    const params = new URLSearchParams(window.location.search);
    const room = params.get("room") || "lobby";
    const nameParam = params.get("name");

    if (nameParam && nameParam.trim()) {
        myName = nameParam.trim().slice(0, 30);
    } else {
        const entered = prompt("Enter your display name:", myName);
        if (entered && entered.trim()) {
            myName = entered.trim().slice(0, 30);
        }
    }

    currentRoom = room;

    const nameLabel = $("viewerNameLabel");
    if (nameLabel) nameLabel.textContent = myName;

    socket.connect();
    socket.emit("join-room", {
        room,
        name: myName,
        isViewer: true
    });

    const sendBtn = $("sendBtn");
    const chatInput = $("chatInput");
    if (sendBtn && chatInput) {
        sendBtn.onclick = sendChat;
        chatInput.onkeydown = (e) => {
            if (e.key === "Enter") sendChat();
        };
    }

    const emojiStrip = $("emojiStrip");
    if (emojiStrip && chatInput) {
        emojiStrip.onclick = (e) => {
            if (e.target.classList.contains("emoji")) {
                chatInput.value += e.target.textContent;
                chatInput.focus();
            }
        };
    }

    const requestBtn = $("requestCallBtn");
    if (requestBtn) {
        requestBtn.onclick = () => {
            socket.emit("request-to-call");
            document.body.classList.add('hand-active'); // Visual patch
            requestBtn.textContent = "Request Sent ✋";
            requestBtn.disabled = true;
        };
    }

    const unmuteBtn = $("unmuteBtn");
    if (unmuteBtn) {
        unmuteBtn.onclick = () => {
            const v = $("viewerVideo");
            if (!v) return;
            const willUnmute = v.muted;

            v.muted = !v.muted;
            v.volume = v.muted ? 0.0 : 1.0;

            if (willUnmute) {
                v.play().catch(() => {});
                unmuteBtn.textContent = "🔊 Mute";
                unmuteBtn.classList.remove('pulse-primary'); // End guidance pulse
            } else {
                unmuteBtn.textContent = "🔇 Unmute";
            }
        };
    }

    const fsBtn = $("fullscreenBtn");
    if (fsBtn) {
        fsBtn.onclick = () => {
            const v = $("viewerVideo");
            if (!v) return;
            if (v.requestFullscreen) v.requestFullscreen();
            else if (v.webkitRequestFullscreen) v.webkitRequestFullscreen();
            else if (v.msRequestFullscreen) v.msRequestFullscreen();
        };
    }

    const toggleChatBtn = $("toggleChatBtn");
    if (toggleChatBtn) {
        toggleChatBtn.onclick = () => {
            const box = $("chatBox");
            if (!box) return;
            box.classList.toggle("hidden");
        };
    }
});

/**
 * side-loader.js
 * P2P Binary Transfer Protocol
 * Chunks files into 16KB packets to bypass server limits.
 */

const CHUNK_SIZE = 16 * 1024; // 16KB (Safe WebRTC limit)
const MAX_BUFFER = 256 * 1024; // 256KB Max Buffer before pausing

// --- HOST: SENDING LOGIC ---
export async function pushFileToPeer(pc, file, onProgress) {
    if (!pc) return;
    
    // Create a specific channel for this file transfer
    const channel = pc.createDataChannel("side-load-pipe");
    
    channel.onopen = async () => {
        // 1. Send Metadata (Name, Size, Type)
        const metadata = JSON.stringify({
            type: 'meta',
            name: file.name,
            size: file.size,
            mime: file.type
        });
        channel.send(metadata);

        // 2. Read & Chunk File
        const buffer = await file.arrayBuffer();
        let offset = 0;

        const sendLoop = () => {
            // BACKPRESSURE: If buffer is full, wait 10ms and try again
            if (channel.bufferedAmount > MAX_BUFFER) {
                setTimeout(sendLoop, 10);
                return;
            }

            // Connection closed? Stop.
            if (channel.readyState !== 'open') return;

            // Send Chunk
            const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
            channel.send(chunk);
            offset += CHUNK_SIZE;

            // Report Progress
            if (onProgress) {
                const percent = Math.min(100, Math.round((offset / file.size) * 100));
                onProgress(percent);
            }

            // Continue or Close
            if (offset < buffer.byteLength) {
                setTimeout(sendLoop, 0); // Unblock UI thread
            } else {
                // Done - wait a moment for flush before closing
                console.log(`[SideLoader] Sent ${file.name}`);
                setTimeout(() => channel.close(), 1000); 
            }
        };
        sendLoop();
    };
}

// --- VIEWER: RECEIVING LOGIC ---
export function setupReceiver(pc, onComplete, onProgress) {
    pc.ondatachannel = (e) => {
        // Only care about our specific pipe
        if (e.channel.label !== "side-load-pipe") return;
        
        const channel = e.channel;
        let receivedChunks = [];
        let totalSize = 0;
        let currentSize = 0;
        let meta = null;

        channel.onmessage = (event) => {
            const data = event.data;

            // 1. Handle Metadata (First packet is always string JSON)
            if (typeof data === 'string') {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.type === 'meta') {
                        meta = parsed;
                        totalSize = meta.size;
                        console.log(`[SideLoader] Incoming: ${meta.name}`);
                        return;
                    }
                } catch(e) {}
            }

            // 2. Handle Binary Chunks
            if (data instanceof ArrayBuffer) {
                receivedChunks.push(data);
                currentSize += data.byteLength;

                // Progress Update
                if (onProgress && totalSize > 0) {
                    const percent = Math.min(100, Math.round((currentSize / totalSize) * 100));
                    onProgress(percent);
                }

                // 3. Reassembly & Finish
                if (currentSize >= totalSize) {
                    const blob = new Blob(receivedChunks, { type: meta ? meta.mime : 'application/octet-stream' });
                    if (onComplete) onComplete({ blob, name: meta ? meta.name : 'download.bin' });
                    
                    // Close channel from receiver side
                    channel.close();
                }
            }
        };
    };
}

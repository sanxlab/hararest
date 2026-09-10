import { Server, IncomingMessage } from 'node:http';
import { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { PLAYER_CHUNK_BYTES, PlayerService } from './player.service';

export function attachPlayerWebSocket(server: Server, service: PlayerService): () => void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const connections = new Map<string, number>();
  const sweep = setInterval(() => service.sweep(), 30_000);
  sweep.unref();

  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const match = /^\/ws\/player\/([a-f0-9]{48})$/.exec(req.url || '');
    const reject = (status: string) => {
      socket.on('error', () => {});
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (!match) return reject('404 Not Found');
    const id = match[1];
    const session = service.get(id);
    if (!session) return reject('410 Gone');
    if (wss.clients.size >= 16 || (connections.get(id) || 0) >= 4) return reject('429 Too Many Requests');
    wss.handleUpgrade(req, socket, head, (ws) => {
      connections.set(id, (connections.get(id) || 0) + 1);
      const timeout = setTimeout(() => ws.terminate(), 120_000);
      timeout.unref();
      ws.on('error', () => {});
      ws.on('message', () => ws.close(1008, 'This connection only delivers audio.'));
      ws.once('close', () => {
        clearTimeout(timeout);
        const count = (connections.get(id) || 1) - 1;
        if (count) connections.set(id, count);
        else connections.delete(id);
      });
      const send = (data: string | Buffer) => new Promise<void>((resolve, rejectSend) => {
        if (ws.readyState !== WebSocket.OPEN) return rejectSend(new Error('Socket closed'));
        ws.send(data, { binary: Buffer.isBuffer(data) }, (error) => error ? rejectSend(error) : resolve());
      });
      void (async () => {
        try {
          const totalChunks = Math.ceil(session.audio.length / PLAYER_CHUNK_BYTES);
          await send(JSON.stringify({ type: 'start', totalChunks, size: session.audio.length, mimeType: session.track.mimeType }));
          for (let index = 0; index < totalChunks; index++) {
            const chunk = session.audio.subarray(index * PLAYER_CHUNK_BYTES, (index + 1) * PLAYER_CHUNK_BYTES);
            const frame = Buffer.allocUnsafe(4 + chunk.length);
            frame.writeUInt32BE(index, 0);
            chunk.copy(frame, 4);
            // Await each write so a slow receiver cannot queue an entire audio file.
            await send(frame);
          }
          await send(JSON.stringify({ type: 'end' }));
          ws.close(1000, 'Audio complete');
        } catch {
          ws.terminate();
        }
      })();
    });
  };
  server.on('upgrade', upgrade);
  return () => {
    clearInterval(sweep);
    server.off('upgrade', upgrade);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    service.close();
  };
}

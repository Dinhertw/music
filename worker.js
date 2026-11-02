export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    if (url.pathname === "/ws") {
      const roomId = url.searchParams.get("room") || "default_room";
      const id = env.MY_DURABLE_OBJECT.idFromName(roomId);
      const stub = env.MY_DURABLE_OBJECT.get(id);
      return stub.fetch(request);
    }

    if (url.pathname === "/") {
      return env.ASSETS.fetch(new Request(new URL('/play.html', request.url), request));
    }

    try {
      return await env.ASSETS.fetch(request);
    } catch (e) {
      return new Response("Not Found", { status: 404 });
    }
  }
};

export class MyDurableObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.playlist = [];
    this.history = [];

    this.state.blockConcurrencyWhile(async () => {
      this.playlist = (await this.state.storage.get("playlist")) || [];
      this.history = (await this.state.storage.get("history")) || [];
    });
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get("Upgrade");

    if (upgradeHeader === "websocket") {
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      this.state.acceptWebSocket(server);

      server.send(JSON.stringify({
        action: "SYNC_STATE",
        playlist: this.playlist,
        history: this.history
      }));

      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "POST") {
      try {
        const body = await request.json();
        await this.handleAction(body.action, body, null);
        return new Response(JSON.stringify({ success: true, playlist: this.playlist, history: this.history }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 400 });
      }
    }

    return new Response("Karaoke Room Active", { status: 200 });
  }

  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);
      await this.handleAction(data.action, data, ws);
    } catch (e) {}
  }

  async webSocketClose(ws, code, reason, wasClean) {
    ws.close();
  }

  async handleAction(action, payload, senderWs) {
    let changed = false;

    if (action === "addSong" && payload.song) {
      this.playlist.push(payload.song);
      const now = new Date();
      const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
      this.history.unshift({
        id: payload.song.id,
        title: payload.song.title,
        requestTime: timeStr,
        videoDuration: payload.song.videoDuration || '03:30'
      });
      changed = true;
    } 
    else if (action === "removeSong" && typeof payload.index === "number") {
      if (payload.index >= 0 && payload.index < this.playlist.length) {
        this.playlist.splice(payload.index, 1);
        changed = true;
      }
    } 
    else if (action === "moveToHistory") {
      if (this.playlist.length > 0) {
        const finishedSong = this.playlist.shift();
        if (!this.history.some(h => h.id === finishedSong.id)) {
          const now = new Date();
          const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
          this.history.unshift({
            id: finishedSong.id,
            title: finishedSong.title,
            requestTime: timeStr,
            videoDuration: '03:30'
          });
        }
        changed = true;
      }
    } 
    else if (action === "clearHistory") {
      this.history = [];
      changed = true;
    }
    else if (action === "syncPlaylist" && Array.isArray(payload.playlist)) {
      this.playlist = payload.playlist;
      changed = true;
    }
    // 遠端控制指令與時間同步直接廣播給房內其他連線
    else if (action === "REMOTE_CMD" || action === "SEEK_TIME" || action === "SYNC_TIME") {
      this.broadcastMessage(payload, senderWs);
      return;
    }

    if (changed) {
      await this.state.storage.put("playlist", this.playlist);
      await this.state.storage.put("history", this.history);
      this.broadcastState();
    }
  }

  broadcastMessage(payload, senderWs) {
    const data = JSON.stringify(payload);
    for (const ws of this.state.getWebSockets()) {
      if (ws !== senderWs) {
        try { ws.send(data); } catch (e) { ws.close(); }
      }
    }
  }

  broadcastState() {
    const data = JSON.stringify({
      action: "SYNC_STATE",
      playlist: this.playlist,
      history: this.history
    });

    for (const ws of this.state.getWebSockets()) {
      try { ws.send(data); } catch (e) { ws.close(); }
    }
  }
}

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
    this.masterWebSocket = null; // 追蹤當前唯一的 Master 連線

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

      const url = new URL(request.url);
      const isParamMaster = url.searchParams.get("master") === "true";
      
      let finalIsMaster = false;
      let conflict = false;

      if (isParamMaster) {
        // 檢查是否已經有 Master 存在且連線中 (readyState === 1 代表 OPEN)
        if (!this.masterWebSocket || this.masterWebSocket.readyState !== 1) {
          this.masterWebSocket = server; // 成功佔用 Master
          finalIsMaster = true;
        } else {
          conflict = true; // 已經被別人佔用了！
          finalIsMaster = false; // 強制降級為 Viewer
        }
      }

      server.send(JSON.stringify({
        action: "INIT_ROLE",
        isMaster: finalIsMaster,
        hasConflict: conflict,
        playlist: this.playlist,
        history: this.history
      }));

      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "POST") {
      try {
        const body = await request.json();
        await this.handleAction(body.action, body);
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
      if (data.action === "REMOTE_CMD" || data.action === "SEEK_TIME" || data.action === "SYNC_TIME") {
        this.broadcastRaw(message);
        return;
      }
      await this.handleAction(data.action, data);
    } catch (e) {}
  }

  async webSocketClose(ws, code, reason, wasClean) {
    // 如果關閉的是當前 Master，釋放佔用權
    if (ws === this.masterWebSocket) {
      this.masterWebSocket = null;
    }
    ws.close();
  }

  async handleAction(action, payload) {
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
    else if (payload.action === "moveToHistory" || action === "moveToHistory") {
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
    else if (action === "syncPlaylist" && Array.isArray(payload.playlist)) {
      this.playlist = payload.playlist;
      changed = true;
    }

    if (changed) {
      await this.state.storage.put("playlist", this.playlist);
      await this.state.storage.put("history", this.history);
      this.broadcastState();
    }
  }

  broadcastState() {
    const data = JSON.stringify({
      action: "SYNC_STATE",
      playlist: this.playlist,
      history: this.history
    });
    this.broadcastRaw(data);
  }

  broadcastRaw(msg) {
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(msg); } catch (e) { ws.close(); }
    }
  }
}

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
    // 記住房間整體的播放控制狀態 (速度、字幕、自動隱藏、是否播放中)
    this.playerState = {
      isPlaying: true,
      speed: 1.0,
      isSubtitleActive: false,
      isAutoHiderEnabled: false
    };

    this.state.blockConcurrencyWhile(async () => {
      this.playlist = (await this.state.storage.get("playlist")) || [];
      this.history = (await this.state.storage.get("history")) || [];
      const savedState = await this.state.storage.get("playerState");
      if (savedState) this.playerState = savedState;
    });
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get("Upgrade");

    if (upgradeHeader === "websocket") {
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      this.state.acceptWebSocket(server);

      // 新連線時同步完整狀態
      server.send(JSON.stringify({
        action: "SYNC_STATE",
        playlist: this.playlist,
        history: this.history,
        playerState: this.playerState
      }));

      return new Response(null, { status: 101, webSocket: client });
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
    // 更新並廣播播放器狀態 (速度、字幕、自動隱藏、播放暫停)
    else if (action === "UPDATE_PLAYER_STATE") {
      this.playerState = { ...this.playerState, ...payload.state };
      await this.state.storage.put("playerState", this.playerState);
      this.broadcastState(senderWs);
      return;
    }
    else if (action === "REMOTE_CMD" || action === "SEEK_TIME" || action === "SYNC_TIME") {
      this.broadcastMessage(payload, senderWs);
      return;
    }

    if (changed) {
      await this.state.storage.put("playlist", this.playlist);
      await this.state.storage.put("history", this.history);
      this.broadcastState(null);
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

  broadcastState(senderWs) {
    const data = JSON.stringify({
      action: "SYNC_STATE",
      playlist: this.playlist,
      history: this.history,
      playerState: this.playerState
    });

    for (const ws of this.state.getWebSockets()) {
      if (ws !== senderWs) {
        try { ws.send(data); } catch (e) { ws.close(); }
      }
    }
  }
}

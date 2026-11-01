/**
 * ==============================================================================
 * CLOUDFLARE WORKER & DURABLE OBJECT (點歌系統後端 API & WebSocket 廣播)
 * ==============================================================================
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 支援 CORS 預檢
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    // WebSocket 路由轉交給 Durable Object 處理
    if (url.pathname === "/ws") {
      const roomId = url.searchParams.get("room") || "default_room";
      const id = env.MY_DURABLE_OBJECT.idFromName(roomId);
      const stub = env.MY_DURABLE_OBJECT.get(id);
      return stub.fetch(request);
    }

    // 首頁自動導向靜態資產 (play.html)
    if (url.pathname === "/") {
      return env.ASSETS.fetch(new Request(new URL('/play.html', request.url), request));
    }

    // 其他靜態檔案 (play.html, control.html) 由 Cloudflare Assets 提供
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

    // 初始化讀取持久化儲存 (SQLite)
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

      // 接受 WebSocket 連線
      this.state.acceptWebSocket(server);

      // 判斷是否為第一個連進來的播放器 (指定 Master 主控端權限)
      const sockets = this.state.getWebSockets();
      const isFirst = sockets.length === 1;

      // 初次連線發送狀態與 Master 權限指派
      server.send(JSON.stringify({
        action: "INIT_ROLE",
        isMaster: isFirst,
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

      // 1. 廣播手機遙控器 command 與快轉時間 (不寫入持久庫，直接秒級轉發給所有大螢幕)
      if (data.action === "REMOTE_CMD" || data.action === "SEEK_TIME") {
        this.broadcastRaw(message);
        return;
      }

      // 2. 廣播大螢幕播放秒數同步訊號 (給手機遙控器與其他跟播端)
      if (data.action === "SYNC_TIME") {
        this.broadcastRaw(message);
        return;
      }

      // 3. 變更播放清單與歷史紀錄的操作
      await this.handleAction(data.action, data);
    } catch (e) {}
  }

  async webSocketClose(ws, code, reason, wasClean) {
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

  // 廣播最新歌單與歷史資料
  broadcastState() {
    const data = JSON.stringify({
      action: "SYNC_STATE",
      playlist: this.playlist,
      history: this.history
    });
    this.broadcastRaw(data);
  }

  // 廣播原始訊息給所有人
  broadcastRaw(msg) {
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(msg);
      } catch (e) {
        ws.close();
      }
    }
  }
}

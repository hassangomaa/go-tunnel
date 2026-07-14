module.exports = {
  apps: [
    {
      name: 'go-tunnel',
      script: '/opt/go-tunnel/server.js',
      cwd: '/opt/go-tunnel',
      env: {
        PORT: 4055,
        LIST_LIMIT: 200,
        DATA_DIR: '/opt/go-tunnel/data',
        SQLITE_PATH: '/opt/go-tunnel/data/visits.db',
        PAYLOAD_PATH: '/probe',
        PUBLIC_URL: 'https://go.tejarahlntpoor.com',
        TARGET_URL: 'http://127.0.0.1:3000',
      },
    },
    {
      name: 'go-tunnel-client',
      script: '/opt/go-tunnel/client.js',
      cwd: '/opt/go-tunnel',
      env: {
        GO_WS: 'wss://go.tejarahlntpoor.com/ws',
        TARGET_URL: 'http://127.0.0.1:3000',
      },
    },
  ],
};

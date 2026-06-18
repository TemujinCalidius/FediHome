module.exports = {
  apps: [{
    name: 'fedihome',
    script: 'npm',
    args: 'start',
    cwd: __dirname,
    env: {
      NODE_ENV: 'production',
      // Forward PORT so pm2 deploys can bind a non-3000 port (defaults to 3000).
      PORT: process.env.PORT || 3000,
    },
    // Auto-restart on crash
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 5000,
  }],
};

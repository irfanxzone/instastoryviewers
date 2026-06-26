module.exports = {
  apps: [
    {
      name: 'instagram-viewer',
      script: 'src/server.js',
      // Browser workers hold persistent Chrome profiles and in-memory locks.
      // Run one Node process per container so one IG account/proxy is not used
      // concurrently by multiple cluster processes.
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 3000
      },
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      restart_delay: 3000,
      max_restarts: 10
    }
  ]
};

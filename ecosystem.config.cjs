module.exports = {
    apps: [
        {
            name: 'polybot',
            script: 'pm2-bootstrap.cjs',
            cwd: __dirname,
            watch: false,
            autorestart: true,
            max_restarts: 10,
            restart_delay: 5000,
            env: {
                NODE_ENV: 'production',
            },
        },
    ],
};

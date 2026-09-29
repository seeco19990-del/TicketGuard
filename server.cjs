// server.js
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // public 폴더 안의 index.html 제공

// 터미널 색상 설정 (시연할 때 멋있어 보임!)
const colors = {
    info: '\x1b[36m%s\x1b[0m',     // Cyan
    success: '\x1b[32m%s\x1b[0m',  // Green
    error: '\x1b[31m%s\x1b[0m',    // Red
    system: '\x1b[35m%s\x1b[0m'    // Magenta
};

// 프론트엔드에서 로그를 보내면 터미널에 출력하는 API
app.post('/api/log', (req, res) => {
    const { msg, type } = req.body;
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    const colorCode = colors[type] || '\x1b[37m%s\x1b[0m'; // 기본 흰색
    
    // VS Code 터미널에 출력!
    console.log(colorCode, `[${time}] ${msg}`);
    res.sendStatus(200);
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(colors.system, `\n=================================================`);
    console.log(colors.system, `🛡️ TicketGuard Live Demo Server Started on Port ${PORT}`);
    console.log(colors.system, `👉 http://localhost:${PORT} 에 접속하세요.`);
    console.log(colors.system, `=================================================\n`);
});
const fs = require('fs');
const js = fs.readFileSync('dist/bundle.js', 'utf8');
const css = fs.readFileSync('dist/bundle.css', 'utf8');
const html = `<!DOCTYPE html>
<html lang='en'>
<head>
<meta charset='UTF-8'>
<meta name='viewport' content='width=device-width, initial-scale=1.0'>
<title>Synthesizer Editor</title>
<style>${css}</style>
</head>
<body style='margin:0;padding:0;background:#0a0a0f;'>
<div id='root'></div>
<script>${js}</script>
</body>
</html>`;
fs.writeFileSync('dist/synth-standalone.html', html);
console.log("HTML generated successfully!");

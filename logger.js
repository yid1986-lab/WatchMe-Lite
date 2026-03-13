function log(level, scope, message) {
  const time = new Date().toISOString();
  console.log(`[${time}] [${level}] [${scope}] ${message}`);
}

module.exports = { log };
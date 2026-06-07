function notFound(req, res) {
  res.status(404).json({ ok: false, error: `No route for ${req.method} ${req.path}` });
}

module.exports = notFound;

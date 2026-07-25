// POST /settings/validate — Salla calls this before saving the native App
// Settings form; returning success unblocks that save path.
module.exports = function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  return res.status(200).json({ success: true });
};

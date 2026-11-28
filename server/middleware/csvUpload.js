const multer = require('multer');
const { sanitizeString } = require('./security');

const parseCsv = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 5 * 1024 * 1024,
    // Both forms use a single file. Allow flat metadata but no nested keys or array indices.
    fieldNestingDepth: 0,
  },
  fileFilter(req, file, cb) {
    if (file.mimetype !== 'text/csv') {
      return cb(Object.assign(new Error('Invalid file type'), { status: 400, details: 'Only text/csv files are allowed' }));
    }
    if (file.originalname.includes('..') || /[/\\]/.test(file.originalname)) {
      return cb(Object.assign(new Error('Invalid filename'), { status: 400, details: 'Filename contains invalid characters' }));
    }
    file.originalname = sanitizeString(file.originalname);
    cb(null, true);
  },
}).single('csvFile');

module.exports = function uploadCsv(req, res, next) {
  parseCsv(req, res, err => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large', details: 'Maximum file size is 5MB' });
      }
      return res.status(400).json({ error: err.message, code: err.code });
    }
    if (err.status === 400) {
      return res.status(400).json({ error: err.message, details: err.details });
    }
    next(err);
  });
};

// app.js - unified server for both sites (Express + MongoDB)
// Install dependencies:
// npm i express body-parser mongoose multer xlsx exceljs dotenv cors express-session bcryptjs

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const xlsx = require('xlsx');
const multer = require('multer');
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const cors = require('cors');
const session = require('express-session');
const bcrypt = require('bcryptjs');

require('dotenv').config();

const app = express();

// ---------- CONFIG ----------
const MONGODB_URI = process.env.MONGODB_URI || 'YOUR_MONGODB_URI_HERE';
const PORT = process.env.PORT || 5000; // default 5000 to match your fetch
console.log('MONGODB_URI config status:', (MONGODB_URI && !MONGODB_URI.includes('YOUR_MONGODB_URI_HERE')) ? 'using env' : 'MONGODB_URI not set - edit .env or app.js');

// ---------- MIDDLEWARE ----------
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static('js'));

// If your frontend is served from a different origin and you use credentials (sessions),
// configure CORS accordingly. For simple same-origin setups, default cors() is okay.
app.use(cors()); // dev-friendly; tighten origin & credentials in production

// If behind a reverse proxy (nginx, load balancer), enable trust proxy so req.ip and x-forwarded-for behave correctly.
// If unsure and you are deploying behind a proxy, set true.
app.set('trust proxy', true);

// ---------- SESSION ----------
app.use(session({
  secret: process.env.SESSION_SECRET || 'please_change_this_to_a_strong_secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    // maxAge = 7 days (adjust as needed)
    maxAge: 7 * 24 * 3600 * 1000
    // In production use secure: true if using HTTPS
  }
}));

// ---------- MONGOOSE CONNECT ----------
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 30000
})
.then(() => console.log('MongoDB connected successfully'))
.catch(err => {
  console.error('MongoDB connection error:', err);
});

// ---------- SCHEMA & MODELS ----------
// flexible generic schema for existing collections
const flexibleSchema = new mongoose.Schema({}, { strict: false });
// const SlaggingData = mongoose.models.SlaggingData || mongoose.model('SlaggingData', flexibleSchema);

// Force Coal model to use 'coals' collection (as in your DB)
let Coal;
try {
  Coal = mongoose.model('Coal');
} catch (e) {
  Coal = mongoose.model('Coal', flexibleSchema, 'coals'); // explicit collection name
}
console.log('Coal collection name:', Coal.collection && Coal.collection.name);

// ---------- USER MODEL (for trials / subscription) ----------
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, index: true },
  passwordHash: { type: String, required: true },
  trialsLeft: { type: Number, default: 5 },            // number of remaining trials
  lockedUntil: { type: Date, default: null },          // when lock expires
  lastIP: { type: String, default: null },             // last known IP
  ipHistory: [{ ip: String, when: Date }],             // optional history
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

const User = mongoose.models.User || mongoose.model('User', userSchema);

// ---------- HELPERS ----------
function excelSerialToDate(serial) {
  const excelEpoch = new Date(Date.UTC(1900, 0, 1));
  const daysOffset = serial - 1;
  const date = new Date(excelEpoch.getTime() + daysOffset * 24 * 60 * 60 * 1000);
  return date.toISOString().split('T')[0];
}

/**
 * normalizeCoalDoc: converts a DB document (various field-naming variants)
 * into a canonical object expected by frontends:
 */
function normalizeCoalDoc(raw) {
  if (!raw) return null;
  const o = (raw.toObject ? raw.toObject() : Object.assign({}, raw));
  const id = String(o._id || o.id || '');

  const coalName = o.coal || o.name || o['Coal source name'] || o['Coal Source Name'] || '';
  const transportId = o['Transport ID'] || o.transportId || o.transport_id || null;

  const canonicalKeys = ['SiO2','Al2O3','Fe2O3','CaO','MgO','Na2O','K2O','TiO2','SO3','P2O5','Mn3O4','Sulphur (S)','GCV'];

  const aliasMap = {
    'SiO2': 'SiO2', 'SiO₂': 'SiO2',
    'Al2O3': 'Al2O3', 'Al₂O₃': 'Al2O3',
    'Fe2O3': 'Fe2O3', 'Fe₂O₃': 'Fe2O3',
    'CaO': 'CaO',
    'MgO': 'MgO',
    'Na2O': 'Na2O',
    'K2O': 'K2O',
    'TiO2': 'TiO2', 'TiO₂': 'TiO2',
    'SO3': 'SO3', 'SO₃': 'SO3',
    'P2O5': 'P2O5', 'P₂O₅': 'P2O5',
    'Mn3O4': 'Mn3O4', 'Mn₃O₄': 'Mn3O4',
    'Sulphur (S)': 'Sulphur (S)',
    'SulphurS': 'Sulphur (S)', 'Sulphur': 'Sulphur (S)', 'S': 'Sulphur (S)',
    'GCV': 'GCV', 'Gcv': 'GCV', 'gcv': 'GCV'
  };

  const properties = {};
  canonicalKeys.forEach(k => properties[k] = null);

  function collectFrom(obj) {
    if (!obj) return;
    Object.keys(obj).forEach(k => {
      const trimmed = String(k).trim();
      let mapped = aliasMap[trimmed] || null;
      if (!mapped) {
        const normalizedKey = trimmed.replace(/₂/g,'2').replace(/₃/g,'3').replace(/₄/g,'4');
        mapped = aliasMap[normalizedKey] || null;
      }
      if (mapped) {
        const val = obj[k];
        properties[mapped] = (val === '' || val === null || val === undefined) ? null : (isNaN(Number(val)) ? val : Number(val));
      }
    });
  }

  collectFrom(o);
  if (o.properties && typeof o.properties === 'object') collectFrom(o.properties);

  if ((properties['GCV'] === null || properties['GCV'] === undefined) && (o.gcv || o.GCV || o.Gcv)) {
    properties['GCV'] = o.gcv || o.GCV || o.Gcv;
  }

  Object.keys(properties).forEach(k => {
    const v = properties[k];
    if (v !== null && v !== undefined && !isNaN(Number(v))) properties[k] = Number(v);
  });

  const gcvVal = properties['GCV'];

  return {
    _id: o._id,
    id,
    coal: coalName,
    coalType: coalName,
    transportId,
    gcv: gcvVal,
    properties
  };
}

// IP helper (works with X-Forwarded-For when trust proxy=true)
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.ip || (req.connection && req.connection.remoteAddress) || null;
}

// Auth middleware
async function requireAuth(req, res, next) {
  try {
    const uid = req.session && req.session.userId;
    if (!uid) return res.status(401).json({ error: 'Not authenticated' });
    const user = await User.findById(uid);
    if (!user) {
      req.session.destroy?.(()=>{});
      return res.status(401).json({ error: 'User not found' });
    }
    // check lock
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return res.status(403).json({ error: 'Account locked until ' + user.lockedUntil.toISOString() });
    }
    req.currentUser = user;
    next();
  } catch (err) {
    console.error('auth error', err);
    res.status(500).json({ error: 'Authentication error' });
  }
}

// ---------- ROUTES ----------
// root route - keep existing login page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// download template
// download template (coal-oriented)
// download template (coal-oriented) — optional data export with ?includeData=true
app.get("/download-template", async (req, res) => {
  try {
    const includeData = String(req.query.includeData || '').toLowerCase() === 'true';

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Coal Upload Template");

    const instructionText = `Instruction for filling the sheet:
1. Row 1 contains instructions (delete this row when uploading).
2. Row 2 must be headers. Required header: "Coal" (name).
3. Other helpful headers: SiO2, Al2O3, Fe2O3, CaO, MgO, Na2O, K2O, TiO2, SO3, P2O5, Mn3O4, Sulphur, GCV, Cost, Transport ID, Shipment date.
4. Leave empty any missing values. Save as .xlsx and upload using the 'file' field.`;

    worksheet.mergeCells('A1:Q1');
    const instructionCell = worksheet.getCell('A1');
    instructionCell.value = instructionText;
    instructionCell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
    instructionCell.font = { bold: true };
    instructionCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
    worksheet.getRow(1).height = 90;

    // Header row (row index 2)
    const headers = [
      "Coal", "SiO2", "Al2O3", "Fe2O3", "CaO", "MgO", "Na2O", "K2O",
      "TiO2", "SO3", "P2O5", "Mn3O4", "Sulphur", "GCV", "Cost", "Transport ID", "Shipment date"
    ];
    worksheet.addRow(headers);
    const headerRow = worksheet.getRow(2);
    headerRow.font = { bold: true };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB0E0E6' } };
      cell.border = {
        top: { style: 'thin' }, left: { style: 'thin' },
        bottom: { style: 'thin' }, right: { style: 'thin' }
      };
    });

    // Set reasonable column widths
    headers.forEach((_, index) => worksheet.getColumn(index + 1).width = 18);

    if (includeData) {
      // Fetch docs from coals collection
      const docs = await Coal.find({}, { __v: 0 }).lean().exec();

      // Helper to choose existing field variants
      function pick(o, ...keys) {
        for (const k of keys) {
          if (o && o[k] !== undefined && o[k] !== null) return o[k];
        }
        return '';
      }

      // Append each DB row into the sheet in the same header order
      for (const d of docs) {
        const rowValues = [
          // Coal name
          pick(d, 'coal', 'Coal', 'name', 'Coal source name'),
          // oxides & properties — try common canonical and alternate keys
          pick(d, 'SiO2', 'SiO₂', 'SiO 2'),
          pick(d, 'Al2O3', 'Al₂O₃'),
          pick(d, 'Fe2O3', 'Fe₂O₃'),
          pick(d, 'CaO'),
          pick(d, 'MgO'),
          pick(d, 'Na2O'),
          pick(d, 'K2O'),
          pick(d, 'TiO2', 'TiO₂'),
          pick(d, 'SO3', 'SO₃'),
          pick(d, 'P2O5', 'P₂O₅'),
          pick(d, 'Mn3O4', 'Mn₃O₄', 'MN3O4'),
          // Sulphur field may be SulphurS / Sulphur / S / Sulphur (S)
          pick(d, 'SulphurS', 'Sulphur (S)', 'Sulphur', 'S'),
          // GCV/gcv
          pick(d, 'GCV', 'gcv', 'Gcv'),
          // cost
          pick(d, 'cost', 'Cost'),
          // transport id and shipment date
          pick(d, 'Transport ID', 'transportId', 'transport_id'),
          // for shipment date prefer ISO string if Date object or string
          (() => {
            const sd = pick(d, 'shipmentDate', 'Shipment date', 'shipment_date');
            if (!sd) return '';
            if (sd instanceof Date) return sd.toISOString().split('T')[0];
            // if mongo stores as object like {"$date": "..."} or as string, coerce to string
            return String(sd);
          })()
        ];
        worksheet.addRow(rowValues);
      }
    }

    res.setHeader("Content-Disposition", `attachment; filename=${includeData ? 'Coal_Data_Export.xlsx' : 'Coal_Upload_Template.xlsx'}`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('/download-template error:', err);
    res.status(500).send('Template generation failed');
  }
});



// multer memory storage for uploads
const storage = multer.memoryStorage();
const upload = multer({ storage });

// upload excel -> SlaggingData collection
// upload excel -> insert into 'coals' collection
// upload excel -> insert into 'coals' collection (robust header detection & normalization)
app.post("/upload-excel", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  try {
    const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      return res.status(400).json({ error: "No sheets found in workbook" });
    }

    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    // Read as rows array so we can detect header row robustly (handles instruction/merged header rows)
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: null });

    // find header row index by looking for typical header tokens
    const headerRowIndex = rows.findIndex(r => Array.isArray(r) && r.some(cell => {
      if (!cell) return false;
      const s = String(cell).toLowerCase();
      return /coal|sio2|sio₂|al2o3|gcv|sulphur|si o2|al₂o₃|fe2o3/.test(s);
    }));

    if (headerRowIndex === -1) {
      return res.status(400).json({ error: "Could not find header row in sheet. Ensure headers like 'Coal' or 'SiO2' exist." });
    }

    const rawHeaders = rows[headerRowIndex].map(h => (h === null || h === undefined) ? '' : String(h).trim());
    const dataRows = rows.slice(headerRowIndex + 1);

    // header map (variants -> canonical keys)
    const headerMap = {
      'coal': 'coal', 'coal source name': 'coal', 'coal source': 'coal', 'name': 'coal',

      'sio2': 'SiO2', 'sio₂': 'SiO2', 'si o2': 'SiO2',
      'al2o3': 'Al2O3', 'al₂o₃': 'Al2O3',
      'fe2o3': 'Fe2O3', 'fe₂o₃': 'Fe2O3',
      'cao': 'CaO', 'mgo': 'MgO',
      'na2o': 'Na2O', 'k2o': 'K2O',
      'tio2': 'TiO2', 'tio₂': 'TiO2',
      'so3': 'SO3', 'so₃': 'SO3',
      'p2o5': 'P2O5', 'p₂o₅': 'P2O5',
      'mn3o4': 'Mn3O4', 'mn₃o₄': 'Mn3O4',

      'sulphur (s)': 'SulphurS', 'sulphur': 'SulphurS', 'sulphurs': 'SulphurS', 's': 'SulphurS',
      'gcv': 'gcv', 'gcv.': 'gcv', 'g c v': 'gcv',
      'cost': 'cost', 'price': 'cost',
      'transport id': 'Transport ID', 'data uploaded by tps': 'uploadedBy', 'shipment date': 'shipmentDate', 'type of transport': 'transportType'
    };

    // helper to canonicalize header string
    function canonicalHeader(h) {
      if (h === null || h === undefined) return '';
      const s = String(h).trim();
      const simple = s.replace(/[\s_\-\.]/g, '').replace(/₂/g,'2').replace(/₃/g,'3').replace(/₄/g,'4').toLowerCase();
      // try exact headerMap keys first
      const direct = Object.keys(headerMap).find(k => k.toLowerCase() === s.toLowerCase());
      if (direct) return headerMap[direct];
      const found = Object.keys(headerMap).find(k => k.replace(/[\s_\-\.]/g,'').replace(/₂/g,'2').replace(/₃/g,'3').replace(/₄/g,'4').toLowerCase() === simple);
      return found ? headerMap[found] : s; // fallback to original header text if not found
    }

    // build canonical headers array
    const canonicalHeaders = rawHeaders.map(h => canonicalHeader(h));

    // map rows to objects
    const parsed = dataRows.map((row, rowIndex) => {
      // skip completely empty rows
      if (!Array.isArray(row) || row.every(c => c === null || (typeof c === 'string' && c.trim() === ''))) return null;

      const out = {};
      for (let i = 0; i < canonicalHeaders.length; i++) {
        const key = canonicalHeaders[i];
        // skip empty header slots
        if (!key) continue;
        let val = row[i] === undefined ? null : row[i];

        // convert excel date serials if header indicates date (optional)
        if (key.toLowerCase().includes('date') && typeof val === 'number' && val > 0 && val < 2958465) {
          val = excelSerialToDate(val);
        } else if (val === '') {
          val = null;
        }

        // convert numeric-like strings to Number
        if (val !== null && typeof val !== 'number') {
          const maybeNum = Number(String(val).replace(/,/g, '').trim());
          if (!Number.isNaN(maybeNum)) val = Math.round(maybeNum * 100) / 100;
        }

        out[key] = val;
      }

      // require coal name
      if (!out.coal || String(out.coal).trim() === '') return null;
      return out;
    }).filter(Boolean);

    if (!parsed.length) {
      return res.status(400).json({ error: "No valid data rows found after header (check your Excel file)" });
    }

    // Insert into coals collection; unordered so one bad row won't stop others
    const inserted = await Coal.insertMany(parsed, { ordered: false });
    res.json({ message: "Data uploaded successfully", rowsParsed: parsed.length, rowsInserted: inserted.length, sample: inserted.slice(0,5) });

  } catch (error) {
    console.error("Error processing file (upload-excel):", error);
    res.status(500).json({ error: "Failed to process file", details: String(error) });
  }
});



// fetch raw SlaggingData
// fetch all coals
app.get("/fetch-data", async (req, res) => {
  try {
    const data = await Coal.find({}, { __v: 0 }).lean();
    res.json(data);
  } catch (error) {
    console.error("Error fetching data:", error);
    res.status(500).json({ error: "Failed to fetch data" });
  }
});

// delete route -> remove docs from 'coals'
app.delete("/delete-data", async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "No IDs provided" });

    const result = await Coal.deleteMany({ _id: { $in: ids } });
    if (result.deletedCount === 0) return res.status(404).json({ error: "No data found" });
    res.json({ message: `${result.deletedCount} data deleted successfully` });
  } catch (error) {
    console.error("Error deleting data:", error);
    res.status(500).json({ error: "Failed to delete data" });
  }
});


// ---------- AFT calculator (kept) ----------
function calculateAFT(values) {
  const [SiO2, Al2O3, Fe2O3, CaO, MgO, Na2O, K2O, SO3, Ti2O] = values;
  const sumSiAl = SiO2 + Al2O3;
  if (sumSiAl < 55) {
      return (
          1245 + 1.1 * SiO2 + 0.95 * Al2O3 - 2.5 * Fe2O3 - 2.98 * CaO - 4.5 * MgO -
          7.89 * (Na2O + K2O) - 1.7 * SO3 - 0.63 * Ti2O
      );
  } else if (sumSiAl >= 55 && sumSiAl < 75) {
      return (
          1323 + 1.45 * SiO2 + 0.683 * Al2O3 - 2.39 * Fe2O3 - 3.1 * CaO - 4.5 * MgO -
          7.49 * (Na2O + K2O) - 2.1 * SO3 - 0.63 * Ti2O
      );
  } else {
      return (
          1395 + 1.2 * SiO2 + 0.9 * Al2O3 - 2.5 * Fe2O3 - 3.1 * CaO - 4.5 * MgO -
          7.2 * (Na2O + K2O) - 1.7 * SO3 - 0.63 * Ti2O
      );
  }
}

// ---------- AUTH ROUTES ----------

// POST /auth/login  { email, password }
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email & password required' });

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    // check locked
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return res.status(403).json({ error: 'Account locked until ' + user.lockedUntil.toISOString() });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    // update last IP
    const ip = getClientIp(req);
    user.lastIP = ip;
    user.ipHistory = user.ipHistory || [];
    user.ipHistory.push({ ip, when: new Date() });
    await user.save();

    // create session
    req.session.userId = user._id.toString();

    res.json({ message: 'Logged in', trialsLeft: user.trialsLeft });
  } catch (err) {
    console.error('/auth/login error', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /auth/logout
app.post('/auth/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) console.error('session destroy err', err);
    res.json({ message: 'Logged out' });
  });
});

// GET /auth/status - returns basic auth info
app.get('/auth/status', async (req, res) => {
  try {
    if (!req.session || !req.session.userId) return res.json({ authenticated: false });
    const user = await User.findById(req.session.userId, 'email trialsLeft lockedUntil lastIP');
    if (!user) return res.json({ authenticated: false });
    return res.json({
      authenticated: true,
      email: user.email,
      trialsLeft: user.trialsLeft,
      lockedUntil: user.lockedUntil,
      lastIP: user.lastIP
    });
  } catch (err) {
    console.error('/auth/status error', err);
    res.status(500).json({ error: 'Status check failed' });
  }
});

// ---------- OPTIMIZE ROUTE (modified to enforce trials & log IP) ----------
app.post("/optimize", requireAuth, async (req, res) => {
  try {
    const user = req.currentUser;
    // ensure not locked (requireAuth already checks but double-check)
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return res.status(403).json({ error: 'Account locked until ' + user.lockedUntil.toISOString() });
    }

    // check trials
    if ((user.trialsLeft || 0) <= 0) {
      // enforce lock for 24 hours starting now
      user.lockedUntil = new Date(Date.now() + 24 * 3600 * 1000);
      await user.save();
      req.session.destroy(()=>{});
      return res.status(403).json({ error: 'Trials exhausted. Account locked for 24 hours.' });
    }

    // record IP for this calculation call
    const ip = getClientIp(req);
    user.lastIP = ip;
    user.ipHistory = user.ipHistory || [];
    user.ipHistory.push({ ip, when: new Date() });

    // ---- YOUR EXISTING OPTIMIZATION LOGIC STARTS HERE ----
    const { blends } = req.body;
    if (!blends || !Array.isArray(blends) || blends.length === 0) {
        return res.status(400).json({ error: "Invalid blend data" });
    }
    const oxideCols = ['SiO2', 'Al2O3', 'Fe2O3', 'CaO', 'MgO', 'Na2O', 'K2O', 'SO3', 'TiO2'];
    const coalNames = blends.map(b => b.coal);
    const oxideValues = blends.map(b => oxideCols.map(col => b.properties[col] || 0));
    const minMaxBounds = blends.map(b => [b.min, b.max]);
    const costsPerTon = blends.map(b => b.cost);
    const gcvValue = blends.map(b => b.properties.Gcv);
    const individualCoalAFTs = oxideValues.map((vals, i) => ({
      coal: coalNames[i],
      predicted_aft: calculateAFT(vals)
    }));
    function* generateCombinations(bounds, step) {
      function* helper(index, combo) {
        if (index === bounds.length) {
          const sum = combo.reduce((a, b) => a + b, 0);
          if (sum === 100) yield combo;
          return;
        }
        const [min, max] = bounds[index];
        for (let i = min; i <= max; i += step) yield* helper(index + 1, [...combo, i]);
      }
      yield* helper(0, []);
    }
    const step = 1;
    const validBlends = [];
    for (const blend of generateCombinations(minMaxBounds, step)) {
      const weights = blend.map(x => x / 100);
      const blendedOxides = oxideCols.map((_, i) =>
        oxideValues.reduce((sum, val, idx) => sum + val[i] * weights[idx], 0)
      );
      const predictedAFT = calculateAFT(blendedOxides);
      const totalgcv = blend.reduce((sum, pct, i ) => sum + pct*gcvValue[i], 0) / 100;
      const totalCost = blend.reduce((sum, pct, i) => sum + pct * costsPerTon[i], 0) / 100;
      validBlends.push({ blend, predicted_aft: predictedAFT, cost: totalCost, gcv: totalgcv, blended_oxides: blendedOxides });
    }
    if (validBlends.length === 0) return res.status(404).json({ message: "No valid blends found" });
    const aftVals = validBlends.map(b => b.predicted_aft);
    const costVals = validBlends.map(b => b.cost);
    const aftMin = Math.min(...aftVals);
    const aftMax = Math.max(...aftVals);
    const costMin = Math.min(...costVals);
    const costMax = Math.max(...costVals);
    const blendScores = validBlends.map((b, i) => {
      const aftNorm = (b.predicted_aft - aftMin) / (aftMax - aftMin);
      const costNorm = (costMax - b.cost) / (costMax - costMin);
      return aftNorm + costNorm;
    });
    const bestAftBlend = validBlends[aftVals.indexOf(Math.max(...aftVals))];
    const cheapestBlend = validBlends[costVals.indexOf(Math.min(...costVals))];
    const balancedBlend = validBlends[blendScores.indexOf(Math.max(...blendScores))];
    const currentWeights = blends.map(b => b.current / 100);
    const currentBlendedOxides = oxideCols.map((_, i) =>
      oxideValues.reduce((sum, val, idx) => sum + val[i] * currentWeights[idx], 0)
    );
    const currentAFT = calculateAFT(currentBlendedOxides);
    const currentGCV = blends.reduce((sum, b, i) => sum + (b.current * gcvValue[i]), 0) / 100;
    const currentCost = blends.reduce((sum, b, i) => sum + (b.current * costsPerTon[i]), 0) / 100;
    const currentBlend = { blend: blends.map(b => b.current), predicted_aft: currentAFT, gcv: currentGCV, cost: currentCost };
    // ---- YOUR EXISTING OPTIMIZATION LOGIC ENDS HERE ----

    // decrement trials and save user
    user.trialsLeft = (user.trialsLeft || 1) - 1;
    // if hits 0 we lock and destroy session
    if (user.trialsLeft <= 0) {
      user.lockedUntil = new Date(Date.now() + 24 * 3600 * 1000);
      await user.save();
      req.session.destroy(()=>{});
      return res.status(200).json({
         message: 'Calculation ran and this was your final trial. Account locked for 24 hours.',
         best_aft_blend: bestAftBlend,
         cheapest_blend: cheapestBlend,
         balanced_blend: balancedBlend,
         current_blend: currentBlend,
         individual_coal_afts: individualCoalAFTs,
         trialsLeft: 0,
         lockedUntil: user.lockedUntil
      });
    } else {
      await user.save();
      return res.json({
        best_aft_blend: bestAftBlend,
        cheapest_blend: cheapestBlend,
        balanced_blend: balancedBlend,
        current_blend: currentBlend,
        individual_coal_afts: individualCoalAFTs,
        trialsLeft: user.trialsLeft
      });
    }
  } catch (err) {
    console.error("Optimization error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- COMPATIBILITY API (for second website / input.html) ----------

// Return array of normalized coal docs for dropdowns
app.get(['/api/coal','/api/coals','/api/coal/list','/api/coal/all'], async (req, res) => {
  try {
    const docs = await Coal.find({}).lean().exec();
    const normalized = docs.map(d => normalizeCoalDoc(d));
    return res.json(normalized);
  } catch (err) {
    console.error('GET /api/coals error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
});

// Minimal payload for names-only requests
app.get('/api/coalnames', async (req, res) => {
  try {
    const docs = await Coal.find({}, { coal: 1 }).lean().exec();
    const minimal = docs.map(d => ({ _id: d._id, coal: d.coal || d['Coal source name'] || d.name }));
    return res.json(minimal);
  } catch (err) {
    console.error('GET /api/coalnames error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
});

// Return shape expected by model.html (coal_data: [...])
app.get('/get_coal_types', async (req, res) => {
  try {
    const docs = await Coal.find({}).lean().exec();
    const requiredProps = [
      "SiO2", "Al2O3", "Fe2O3", "CaO", "MgO", "Na2O", "K2O", "TiO2",
      "SO3", "P2O5", "Mn3O4", "Sulphur (S)", "GCV"
    ];
    const coalData = docs.map(row => {
      const id = String(row._id || row.id || '');
      const coalType = row.coal || row.name || row['Coal source name'] || '';
      const transportId = row['Transport ID'] || row.transportId || null;
      const properties = {};
      requiredProps.forEach(prop => {
        properties[prop] = row[prop] !== undefined ? row[prop] : (row[prop.replace('2','₂')] !== undefined ? row[prop.replace('2','₂')] : null);
      });
      if ((properties['GCV'] === null || properties['GCV'] === undefined) && (row.gcv || row.GCV || row.Gcv)) {
        properties['GCV'] = row.gcv || row.GCV || row.Gcv;
      }
      if ((properties['Sulphur (S)'] === null || properties['Sulphur (S)'] === undefined)) {
        properties['Sulphur (S)'] = row['Sulphur (S)'] || row['SulphurS'] || row['Sulphur'] || row.S || null;
      }
      return { id, coalType, transportId, properties };
    });
    return res.json({ coal_data: coalData });
  } catch (error) {
    console.error('/get_coal_types error:', error);
    return res.status(500).json({ error: 'Failed to fetch coal types' });
  }
});
// POST /consume-trial
// Decrements trialsLeft by 1 for the logged-in user, locks account for 24h if it reaches 0,
// logs the user out by destroying the session, and returns current trials and lockedUntil.
app.post('/consume-trial', requireAuth, async (req, res) => {
  try {
    const user = req.currentUser; // set by requireAuth

    // If already locked (should be handled by requireAuth) return locked info
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return res.status(403).json({ error: 'Account locked', lockedUntil: user.lockedUntil, trialsLeft: user.trialsLeft });
    }

    // Decrement only if > 0
    user.trialsLeft = (user.trialsLeft || 0) - 1;

    // If trials go to 0 or negative, lock for 24 hours and destroy session
    if (user.trialsLeft <= 0) {
      user.trialsLeft = 0;
      user.lockedUntil = new Date(Date.now() + 24 * 3600 * 1000);
      await user.save();

      // destroy session (log out)
      req.session.destroy(err => {
        if (err) console.error('session destroy error during consume-trial', err);
        // respond to client (session is gone)
        return res.json({ message: 'Trials exhausted. Account locked for 24 hours.', trialsLeft: user.trialsLeft, lockedUntil: user.lockedUntil });
      });
      return;
    }

    // Otherwise, save and return trialsLeft
    await user.save();
    return res.json({ message: 'Trial consumed', trialsLeft: user.trialsLeft, lockedUntil: user.lockedUntil || null });
  } catch (err) {
    console.error('/consume-trial error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

module.exports = app;

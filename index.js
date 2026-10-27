// Fix DNS SRV resolution en Node.js v17+ / Windows
// El DNS local de Windows bloquea queries SRV de MongoDB Atlas — forzar Google DNS
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

// ───── Registro de plugin global de tenant scope ─────
// IMPORTANTE: debe registrarse ANTES de cargar cualquier modelo para que se aplique a todos.
require('dotenv').config();
const mongooseBootstrap = require('mongoose');
const tenantScopePlugin = require('./models/plugins/tenantScope');
mongooseBootstrap.plugin(tenantScopePlugin);

let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 15000; // 15 segundos
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const hpp = require('hpp');
const { tenantContextMiddleware } = require('./services/tenantContext');

// ───── CORS: allowlist por env ─────
// CORS_ORIGINS="https://app.gemshub.com,https://acme.gemshub.com"
// En dev: si no se define, refleja el origen (acepta localhost:5173, 127.0.0.1, etc.)
const allowlist = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const corsOptions = {
  origin: (origin, callback) => {
    // Permitir llamadas sin origen (Postman, curl, healthchecks) y mismo-origen
    if (!origin) return callback(null, true);
    if (allowlist.length === 0) return callback(null, true); // modo dev
    if (allowlist.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS: origen no autorizado: ${origin}`));
  },
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Organization-Id'],
  exposedHeaders: ['Content-Disposition']
};

const app = express();
const server = http.createServer(app);

// Confiar en el proxy (Render, Cloudflare) para rate limit por IP real
app.set('trust proxy', 1);

// ───── Helmet: cabeceras de seguridad ─────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // permite servir uploads desde el frontend
  contentSecurityPolicy: false // CSP la maneja el frontend en index.html
}));

// CORS antes del parser
app.use(cors(corsOptions));

// Límites de body — protege contra payloads enormes
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Sanitización contra NoSQL injection (remueve $ y . de keys en body/query/params)
app.use(mongoSanitize());

// Bloquea HTTP Parameter Pollution (?role=admin&role=user)
app.use(hpp());

// ───── Rate limiting ─────
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600, // 600 reqs / 15 min por IP (suficiente para SPA activa)
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // 20 intentos de login/registro por IP cada 15 min
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { success: false, message: 'Demasiados intentos. Intenta más tarde.' }
});

// Refresh tokens corren cada ~15min por sesión activa. Con muchas pestañas / múltiples
// usuarios detrás de NAT, no podemos meterlos en el authLimiter (los lockoutearía).
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Demasiadas renovaciones de sesión.' }
});

// Self-service onboarding: estricto contra spam de organizaciones.
const registerOrgLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Demasiados intentos de registro. Intenta en 1 hora.' }
});

app.use('/api/', generalLimiter);

// Socket.IO CORS: usa la misma allowlist
const io = socketIo(server, {
  cors: {
    origin: corsOptions.origin,
    methods: ['GET', 'POST'],
    credentials: true,
  }
});

let avisosGroupId = null; // Guardar el ID del grupo 'avisos' automáticamente

// Servir archivos estáticos de uploads. CORS lo maneja el middleware global (allowlist).
// Cross-Origin-Resource-Policy: cross-origin permite que el frontend cargue las imágenes.
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  setHeaders: (res) => {
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.set('Cache-Control', 'public, max-age=31536000');
  }
}));

// Healthcheck público (sin rate limit estricto)
app.get('/api/health', (req, res) => {
  res.json({ ok: true, mongo: mongoose.connection.readyState === 1 });
});

// Create uploads/chat directory if it doesn't exist
const fs = require('fs');

const chatUploadsDir = path.join(__dirname, 'uploads', 'chat');
if (!fs.existsSync(chatUploadsDir)) {
  fs.mkdirSync(chatUploadsDir, { recursive: true });
}

// Store io instance in app for use in routes
app.set('io', io);

// Importar rutas
const authRoutes = require('./routes/auth');
const clientsRoutes = require('./routes/clients');
const activitiesRoutes = require('./routes/activities');
const paymentsRoutes = require('./routes/payments');
const accountingRoutes = require('./routes/accounting');
const casesRoutes = require('./routes/cases');
const followupsRoutes = require('./routes/followups');
const issuesRoutes = require('./routes/issues');
const notificationsRoutes = require('./routes/notifications');
const docsRoutes = require('./routes/docs');

const minutesRoutes = require('./routes/minutes');
const settingsRoutes = require('./routes/settings');
const teamRoutes = require('./routes/team');
const reportsRoutes = require('./routes/reports');

const chatRoutes = require('./routes/chat');
const prospectsRoutes = require('./routes/prospects');
const avatarRoutes = require('./routes/avatars');
const taskReportsRoutes = require('./routes/taskReports');
const tasksRoutes = require('./routes/tasks');
const taskApprovalsRoutes = require('./routes/taskApprovals');
const trashRoutes = require('./routes/trash');
const boardsRoutes = require('./routes/boards');
const githubRoutes = require('./routes/github');
const ticketsRoutes = require('./routes/tickets');
const rolesRoutes = require('./routes/roles');
const wikiRoutes = require('./routes/wiki');
const aiRoutes = require('./routes/ai');
const adminRoutes = require('./routes/admin');
const dashboardRoutes = require('./routes/dashboard');

// Usar rutas — rate limits específicos por sub-ruta antes del authLimiter genérico.
// Orden importa: los limiters específicos se montan ANTES del general para que matcheen primero.
app.use('/api/auth/refresh', refreshLimiter);
app.use('/api/auth/register-org', registerOrgLimiter);
app.use('/api/auth', authLimiter, authRoutes);

// ───── Wall: todas las demás rutas /api/* requieren autenticación + org activa ─────
// Rutas públicas explícitas que se saltan este wall: las definidas ANTES de esta línea
// (ej. /api/auth, /api/health). Rutas tipo /api/tickets/public deben usar un sub-router.
const { authenticateToken, requireOrganization } = require('./middleware/auth');
const publicWhitelist = [
  /^\/api\/tickets\/public\/[^/]+$/, // formulario externo de soporte (con orgSlug)
  /^\/api\/health$/,
  // Verificación de email — el link llega por correo, no puede pedir token
  /^\/api\/auth\/verify-email\/[^/]+$/,
  // Fotos de perfil servidas desde la BD — un <img> no manda el token
  /^\/api\/avatars\/photo\/[a-f0-9]{24}$/i,
];
app.use('/api', (req, res, next) => {
  if (publicWhitelist.some(rx => rx.test(req.originalUrl.split('?')[0]))) return next();
  return authenticateToken(req, res, (err) => {
    if (err) return next(err);
    return requireOrganization(req, res, next);
  });
});

app.use('/api/clients', clientsRoutes);
app.use('/api/activities', activitiesRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/accounting', accountingRoutes);
app.use('/api/cases', casesRoutes);
app.use('/api/followups', followupsRoutes);
app.use('/api/issues', issuesRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/docs', docsRoutes);
app.use('/api/minutes', minutesRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/team', teamRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/prospects', prospectsRoutes);
app.use('/api/avatars', avatarRoutes);
app.use('/api/task-reports', taskReportsRoutes);
app.use('/api/taskReports', taskReportsRoutes); // Alias para compatibilidad
app.use('/api/tasks', tasksRoutes);
app.use('/api/task-approvals', taskApprovalsRoutes);
app.use('/api/trash', trashRoutes);
app.use('/api/boards', boardsRoutes);
app.use('/api/github', githubRoutes);
app.use('/api/tickets', ticketsRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/wiki', wikiRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/dashboard', dashboardRoutes);


// Conexión a MongoDB usando .env
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', async () => {
  console.log('Connected to MongoDB');
  
  // ─── One-time initialization ───
  const { ensureSupportUser, ensureDefaultRoles, ensureDefaultClientProjects } = require('./services/initService');
  await ensureSupportUser();
  await ensureDefaultRoles();
  await ensureDefaultClientProjects();

  // Papelera: borra definitivamente lo que pasó el plazo de retención
  require('./services/trashService').purgeExpired()
    .then(n => { if (n) console.log(`Papelera: ${n} elemento(s) vencido(s) eliminado(s)`); })
    .catch(e => console.warn('Papelera: no se pudo purgar:', e.message));

  // Inicializar servicios de cron
  const { initTaskReportsCron, initTeamReportsCron, initSlaCron, initActivityDueDateCron } = require('./services/cronService');
  initTaskReportsCron(app);
  initTeamReportsCron(app);
  initSlaCron();
  initActivityDueDateCron();
});

// Socket.IO con autenticación obligatoria + scope por organización (ver socket/index.js)
require('./socket/index')(io);

// ─── Global Error Handling Middleware ───
app.use((err, req, res, next) => {
  console.error('[Global Error]', err.stack || err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error'
  });
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
  console.log(`Customer Touch Backend running on port ${PORT}`);
});

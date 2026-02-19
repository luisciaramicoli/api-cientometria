const express = require("express");
const bodyParser = require("body-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const cors = require("cors");
const {
  searchOpenAlex,
  saveData,
  getCuratedArticles,
  executarCuradoriaLocalmente,
  executarCuradoriaLinhaUnica,
  executarCategorizacaoLinhaUnica,
  deleteRow,
  deleteUnavailableRows,
  manualInsert,
  aprovarManualmente,
  processDriveFolderForBatchInsert,
} = require("./src/services/api_logic.js");
const { getAuthenticatedServices, uploadFileToDrive } = require("./src/services/api_logic.js");
const fs = require('fs').promises;
const path = require('path');
const { pool, initDb, saltRounds } = require("./src/services/database.js"); // Import saltRounds
const { extractMetadata } = require("./src/controllers/metadata_controller.js"); // Importar o novo controller
const multer = require("multer"); // Importar multer

// Configuração do Multer para upload de arquivos em memória
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });


const app = express();
const port = 5001;


// Em um app real, use uma variável de ambiente (process.env.JWT_SECRET)
const JWT_SECRET = process.env.JWT_SECRET || "sua-chave-secreta-super-dificil-de-adivinhar";

// Inicializa o banco de dados e o usuário admin (se necessário)
initDb();

app.use(bodyParser.json());
app.use(cors());

// Middleware para Log de todas as requisições (ajuda no debug do Vercel)
app.use((req, res, next) => {
  console.log(`[API CALL] ${req.method} ${req.url}`);
  next();
});

// --- AUTH MIDDLEWARE ---

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN

  if (token == null) {
    return res.status(401).json({ error: "Token não fornecido." }); // Unauthorized
  }

  jwt.verify(token, JWT_SECRET, async (err, decodedUser) => {
    if (err) {
      console.error("JWT Verify Error:", err.message);
      return res.status(403).json({ error: "Token inválido." }); // Forbidden
    }
    
    try {
      console.log(`Autenticando usuário ID: ${decodedUser.id}`);
      // Buscar dados atualizados do usuário, incluindo permissões
      const [rows] = await pool.execute("SELECT id, username, role, allowed_categories FROM users WHERE id = ?", [decodedUser.id]);
      
      if (rows.length === 0) {
        console.warn(`Usuário ID ${decodedUser.id} não encontrado no banco.`);
        return res.status(401).json({ error: "Usuário não encontrado ou inativo." });
      }
      
      const user = rows[0];
      // Tentar parsear allowed_categories se for uma string JSON
      if (user.allowed_categories) {
        try {
          user.allowed_categories = JSON.parse(user.allowed_categories);
        } catch (e) {
          // Se não for JSON, tratar como string simples (ou array se já for)
        }
      }
      
      req.user = user;
      next();
    } catch (dbErr) {
      console.error("Erro ao verificar usuário no middleware:", dbErr.message);
      res.status(500).json({ error: "Erro interno do servidor." });
    }
  });
};

// Middleware para verificar se o usuário é administrador
const authorizeAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ error: "Acesso negado. Apenas administradores podem realizar esta ação." }); // Forbidden
  }
};

// --- API ROUTES ---

app.get("/", (req, res) => {
  res.send("Node.js API server is running. Use /api/login para autenticar.");
});

// --- Rota de Health Check ---
app.get("/api/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// --- Rota de Login ---
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Usuário e senha são obrigatórios." });
  }

  try {
    const sql = `SELECT *, CAST(id AS CHAR) as id_str FROM users WHERE username = ?`;
    const [rows] = await pool.execute(sql, [username]);

    const user = rows[0];

    if (!user) {
      return res.status(401).json({ error: "Credenciais inválidas." });
    }

    // Compara a senha fornecida com o hash armazenado
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: "Credenciais inválidas." });
    }

    // Gerar o Token JWT
    // Usamos id_str que veio do CAST no SQL
    const userPayload = { username: user.username, id: user.id_str, role: user.role };
    const accessToken = jwt.sign(userPayload, JWT_SECRET, {
      expiresIn: "1h",
    }); // Token expira em 1 hora

    res.json({ accessToken: accessToken });
  } catch (err) {
    console.error("Erro no login (db):", err.message);
    return res.status(500).json({ error: "Erro interno do servidor." });
  }
});

// --- Rota de Registro de Usuário (Apenas para Admin) ---
app.post("/api/register", authenticateToken, authorizeAdmin, async (req, res) => {
  const { username, email, password, role } = req.body;

  if (!username || !email || !password || !role) {
    return res.status(400).json({ error: "Todos os campos são obrigatórios." });
  }

  // Validação simples de role
  const validRoles = ['admin', 'cientometria', 'curadoria_boaretto', 'curadoria_bonetti'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: `Role inválida. Roles permitidas: ${validRoles.join(', ')}.` });
  }

  try {
    const hash = await bcrypt.hash(password, saltRounds);
    const [result] = await pool.execute(
      "INSERT INTO users (username, email, password_hash, role, is_active, allowed_categories) VALUES (?, ?, ?, ?, TRUE, NULL)",
      [username, email, hash, role]
    );
    res.status(201).json({ message: "Usuário registrado com sucesso!", userId: result.insertId });
  } catch (err) {
    console.error("Erro ao registrar usuário:", err.message);
    if (err.code === 'ER_DUP_ENTRY') { // MySQL/TiDB specific error for duplicate entry
      return res.status(409).json({ error: "Nome de usuário ou e-mail já existe." });
    }
    res.status(500).json({ error: "Erro interno do servidor ao registrar usuário." });
  }
});

// --- Rota para Listar Usuários (Admin) ---
app.get("/api/users", authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute("SELECT id, username, email, role, is_active, allowed_categories FROM users");
    res.json(rows);
  } catch (err) {
    console.error("Erro ao listar usuários:", err.message);
    res.status(500).json({ error: "Erro interno do servidor." });
  }
});

// --- Rota para Atualizar Permissões do Usuário (Admin) ---
app.put("/api/users/:id/permissions", authenticateToken, authorizeAdmin, async (req, res) => {
  const { id } = req.params;
  const { role, allowed_categories } = req.body;

  try {
    // allowed_categories deve ser um array ou string (vamos converter para string JSON se for array)
    const categoriesStr = Array.isArray(allowed_categories) ? JSON.stringify(allowed_categories) : (allowed_categories || null);
    
    await pool.execute(
      "UPDATE users SET role = ?, allowed_categories = ? WHERE id = ?",
      [role, categoriesStr, id]
    );
    res.json({ message: "Permissões atualizadas com sucesso!" });
  } catch (err) {
    console.error("Erro ao atualizar permissões:", err.message);
    res.status(500).json({ error: "Erro interno do servidor." });
  }
});

// --- Rotas Protegidas ---

app.post("/api/trigger-curation", authenticateToken, async (req, res) => {
  try {
    // Aponte para a nova função de curadoria local
    const result = await executarCuradoriaLocalmente();
    res.json(result);
  } catch (error) {
    console.error(`Error in /api/trigger-curation: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/trigger-curation-single", authenticateToken, async (req, res) => {
    try {
        const { row_number } = req.body;

        if (!row_number || isNaN(parseInt(row_number, 10))) {
            return res.status(400).json({ error: "Parâmetro 'row_number' é obrigatório e deve ser um número." });
        }

        const result = await executarCuradoriaLinhaUnica(parseInt(row_number, 10));
        res.json(result);
    } catch (error) {
        console.error(`Error in /api/trigger-curation-single: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/categorize-single", authenticateToken, async (req, res) => {
  try {
    const { row_number } = req.body;
    if (!row_number || isNaN(parseInt(row_number, 10))) {
      return res.status(400).json({ error: "Parâmetro 'row_number' é obrigatório e deve ser um número." });
    }
    const result = await executarCategorizacaoLinhaUnica(parseInt(row_number, 10));
    res.json(result);
  } catch (error) {
    console.error(`Error in /api/categorize-single: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/curation", authenticateToken, async (req, res) => {
  try {
    let articles = await getCuratedArticles();
    
    // Filtrar por categoria se o usuário tiver permissões restritas (e não for admin)
    if (req.user.role !== 'admin' && req.user.allowed_categories) {
      const allowed = Array.isArray(req.user.allowed_categories) 
        ? req.user.allowed_categories 
        : [req.user.allowed_categories];
      
      console.log(`Filtrando artigos para o usuário ${req.user.username}. Categorias permitidas: ${allowed}`);
      
      articles = articles.filter(article => {
        // Assume-se que a coluna na planilha é "CATEGORIA"
        const category = article["CATEGORIA"] || article["categoria"];
        return allowed.includes(category);
      });
    }
    
    res.json(articles);
  } catch (error) {
    console.error(`Error in /api/curation: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/search", authenticateToken, async (req, res) => {
  try {
    const { search_terms, start_year, end_year, sort_option } = req.body;

    if (!search_terms) {
      return res
        .status(400)
        .json({ error: "Parameter 'search_terms' is missing." });
    }

    const startYearInt = parseInt(start_year, 10);
    const endYearInt = parseInt(end_year, 10);

    if (isNaN(startYearInt) || isNaN(endYearInt)) {
      return res
        .status(400)
        .json({
          error: "Parameters 'start_year' and 'end_year' must be integers.",
        });
    }

    const results = await searchOpenAlex(
      search_terms,
      startYearInt,
      endYearInt,
      sort_option
    );
    res.json(results);
  } catch (error) {
    console.error(`Error in /api/search: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/save", authenticateToken, async (req, res) => {
  try {
    const { selected_rows } = req.body;

    if (
      !selected_rows ||
      !Array.isArray(selected_rows) ||
      selected_rows.length === 0
    ) {
      return res.status(400).json({ error: "No rows selected to save." });
    }

    const result = await saveData(selected_rows);
    res.json(result);
  } catch (error) {
    console.error(`Error in /api/save: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/delete-row", authenticateToken, async (req, res) => {
    try {
        const { row_number } = req.body;
        if (!row_number) {
            return res.status(400).json({ error: "row_number is required" });
        }
        const result = await deleteRow(parseInt(row_number, 10));
        res.json(result);
    } catch (error) {
        console.error(`Error in /api/delete-row: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/delete-unavailable", authenticateToken, async (req, res) => {
    try {
        const result = await deleteUnavailableRows();
        res.json(result);
    } catch (error) {
        console.error(`Error in /api/delete-unavailable: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// --- Rota para Inserção Manual (suporta upload de PDF) ---
app.post("/api/manual-insert", authenticateToken, upload.single('file'), async (req, res) => {
  try {
    // req.body contains form fields; req.file is optional
    const data = req.body || {};
    console.log('[/api/manual-insert] Received body keys:', Object.keys(req.body || {}));
    console.log('[/api/manual-insert] Received file?:', !!req.file, req.file ? req.file.originalname : null);

    // If a file was uploaded, save to Drive and set pub_url
    if (req.file) {
      const tmpDir = path.join('/tmp', 'temp_uploads');
      await fs.mkdir(tmpDir, { recursive: true });
      const originalName = req.file.originalname || `upload-${Date.now()}.pdf`;
      const tmpPath = path.join(tmpDir, `${Date.now()}-${originalName}`);
      await fs.writeFile(tmpPath, req.file.buffer);

      try {
        const { drive } = await getAuthenticatedServices();
        const webViewLink = await uploadFileToDrive(drive, tmpPath, originalName);
        if (webViewLink) data.pub_url = webViewLink;
      } catch (e) {
        console.error('Error uploading file to Drive:', e.message);
      } finally {
        // attempt to remove temp file
        try { await fs.unlink(tmpPath); } catch (e) { /* ignore */ }
      }
    }

    // Normalize incoming keys to match expected headers (tolerant to encoding/acentuação issues)
    function canonical(str) {
      if (!str) return "";
      return str
        .toString()
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
    }

    const incoming = req.body || {};
    const canonicalMap = {}; // canonicalKey -> originalKey
    Object.keys(incoming).forEach((k) => {
      canonicalMap[canonical(k)] = k;
    });

    // Expected keys as used by manualInsert (source of truth)
    const expectedKeys = [
      'Autor(es)', 'Título', 'Subtítulo', 'Ano', 'Número de citações recebidas (Google Scholar)',
      'Palavras-chave', 'Resumo', 'Tipo de documento', 'Editora', 'Instituição', 'Local', 'Tipo de trabalho',
      'Título do periódico', 'Quartil do periódico', 'Volume', 'Número/fascículo', 'Páginas', 'DOI', 'Numeração', 'Qualis', 'pub_url'
    ];

    // Build finalData with exact expected keys, pulling from incoming using canonical matching
    const finalData = {};
    expectedKeys.forEach((exp) => {
      const key = canonicalMap[canonical(exp)];
      finalData[exp] = key ? incoming[key] : undefined;
    });

    // Validação simples dos dados recebidos (usando finalData)
    if (!finalData['Título'] || !finalData['Autor(es)'] || !finalData.Ano || !finalData['Título do periódico'] && !finalData['Título do periódico']) {
      // Note: some environments may lose accents; also accept 'Titulo' and 'Titulo do periodico' etc.
      const hasTitle = finalData['Título'] || finalData['Título do periódico'] || finalData['Título do periódico'];
      if (!finalData['Título'] || !finalData['Autor(es)'] || !finalData.Ano || !hasTitle) {
        return res.status(400).json({ error: "Campos obrigatórios (Título, Autor(es), Ano, Título do periódico) não preenchidos." });
      }
    }

    const result = await manualInsert(finalData);

    if (result.status === "success") {
      res.status(201).json(result); // 201 Created
    } else {
      res.status(500).json({ error: result.message });
    }
  } catch (error) {
    console.error(`Error in /api/manual-insert: ${error.message}`);
    res.status(500).json({ error: "Falha interna ao processar a solicitação." });
  }
});

app.post("/api/manual-approval", authenticateToken, async (req, res) => {
    try {
        const { row_number, fileId } = req.body;

        if (!row_number || !fileId) {
            return res.status(400).json({ error: "Parâmetros 'row_number' e 'fileId' são obrigatórios." });
        }

        const result = await aprovarManualmente(parseInt(row_number, 10), fileId);
        res.json(result);
    } catch (error) {
        console.error(`Error in /api/manual-approval: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/batch-process-drive-folder", authenticateToken, async (req, res) => {
  try {
    const { folder_id } = req.body;
    if (!folder_id) {
      return res.status(400).json({ error: "O 'folder_id' é obrigatório." });
    }

    const result = await processDriveFolderForBatchInsert(folder_id);
    res.json(result);
  } catch (error) {
    console.error(`Error in /api/batch-process-drive-folder: ${error.message}`);
    res.status(500).json({ error: "Falha interna ao iniciar o processamento em lote." });
  }
});

// --- Nova Rota para Extração de Metadados ---
app.post("/api/extract-metadata", authenticateToken, upload.single('file'), extractMetadata);



// --- SERVER START ---

app.listen(port, () => {
  console.log("--- Node.js Express Server Starting ---");
  console.log(`Listening on http://127.0.0.1:${port}`);
  console.log(
    "Servidor pronto. Usando banco de dados TiDB para autenticação.",
  );
});

// Exportar o app para compatibilidade correta com Vercel
module.exports = app;

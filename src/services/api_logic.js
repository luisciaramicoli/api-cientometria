const {
  ALL_METADATA_FIELDS,
} = require("../controllers/metadata_controller.js");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const axios = require("axios");
const { authenticate } = require("@google-cloud/local-auth");
const { google } = require("googleapis");

// --- CONFIGURATION ---
const SHEET_NAME = process.env.SHEET_NAME || "Tabela completa";
const EMAIL_CONTATO = process.env.EMAIL_CONTATO || "luisgustavobonfim996@gmail.com";
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || "1JILjVMPaEzssc46DxRjuS7kwvPVnPohj";
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || "1651Lad3tOgA-NiQ3VDZZn33Y04UCiPUzuM2uZxXeUuA";
const API_BASE_URL = process.env.API_BASE_URL || "https://curadoria-llm-curadoria.hf.space";
const ID_PASTA_APROVADOS = process.env.ID_PASTA_APROVADOS || "1HfRf6P3_8nhAVWXCfzmKAZEnTVcvciDG";
const ID_PASTA_REPROVADOS = process.env.ID_PASTA_REPROVADOS || "1uvxxgmbvTh2UoMxxvYREYFpuMTueFNBt";

const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
];

// --- AUTHENTICATION ---
async function loadTokenIfExists() {
  const tokenData = process.env.GOOGLE_AUTH_TOKEN_DATA;
  if (!tokenData) {
    return null;
  }
  try {
    const credentials = JSON.parse(tokenData);
    return google.auth.fromJSON(credentials);
  } catch (err) {
    console.error("Error parsing GOOGLE_AUTH_TOKEN_DATA:", err.message);
    return null;
  }
}

async function saveCredentials(client) {
  // In a serverless environment like Vercel, we don't save credentials to a file.
  // Instead, the user should update their GOOGLE_AUTH_TOKEN_DATA environment variable
  // with the new refresh token if it changes (e.g., after initial authorization).
  if (client.credentials && client.credentials.refresh_token) {
    console.log("New refresh token obtained. Please update your GOOGLE_AUTH_TOKEN_DATA environment variable with the following JSON, ensuring it includes the refresh_token:");
    // For local development, you might want to print the full JSON for easy copy-pasting
    // For production, just inform the user.
    console.log(JSON.stringify({
      type: "authorized_user",
      client_id: client.credentials.client_id,
      client_secret: client.credentials.client_secret,
      refresh_token: client.credentials.refresh_token,
      // Add other relevant fields if necessary
    }, null, 2));
  } else {
    console.log("No new refresh token to save or update.");
  }
  // In a Vercel context, this function primarily serves as a notification mechanism.
}

async function authorize() {
  let client = await loadTokenIfExists();
  if (client) return client;

  // If no existing token data, try to use GOOGLE_CREDENTIALS for initial setup
  const googleCredentials = process.env.GOOGLE_CREDENTIALS;
  if (!googleCredentials) {
    throw new Error("GOOGLE_CREDENTIALS environment variable is not set. Cannot authorize Google APIs.");
  }

  let keys;
  try {
    keys = JSON.parse(googleCredentials);
  } catch (err) {
    throw new Error("Error parsing GOOGLE_CREDENTIALS environment variable. Make sure it's valid JSON.");
  }

  const { client_id, client_secret, redirect_uris } = keys.installed || keys.web;
  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0] // Assuming the first redirect URI is used
  );

  // In a Vercel environment, direct interactive authentication is not possible.
  // The expectation is that a refresh token is obtained locally and then
  // GOOGLE_AUTH_TOKEN_DATA is set as an environment variable.
  // If we reach this point, it means GOOGLE_AUTH_TOKEN_DATA was empty/invalid.
  // We cannot proceed with an interactive flow.
  throw new Error(
    "GOOGLE_AUTH_TOKEN_DATA environment variable is missing or invalid. " +
    "Please obtain a Google API refresh token locally and set it as GOOGLE_AUTH_TOKEN_DATA " +
    "in your Vercel project environment variables."
  );
}

async function getAuthenticatedServices() {
  const auth = await authorize();
  const drive = google.drive({ version: "v3", auth });
  const sheets = google.sheets({ version: "v4", auth });
  return { drive, sheets };
}

// --- HELPER FUNCTIONS ---
const getDriveIdFromUrl = (url) => (url.match(/[-\w]{25,}/) || [])[0];
const normalizarBooleano = (v) =>
  ["true", "sim", "yes", "verdadeiro", "aprovado", "1"].includes(
    String(v || "").toLowerCase(),
  );

// Converte um índice 0-based de coluna para notação A1 (A, B, ..., Z, AA, AB, ...)
function colIndexToA1(colIndex) {
  let s = "";
  let n = colIndex + 1; // 1-based
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function callCustomCuradorApi(pdfBuffer, headers, category = null) {
  const payload = {
    encoded_content: pdfBuffer.toString("base64"),
    content_type: "pdf",
    headers,
    category,
  };
  try {
    const res = await axios.post(`${API_BASE_URL}/curadoria`, payload, {
      timeout: 120000,
      headers: { "Content-Type": "application/json" },
    });
    return res.data;
  } catch (error) {
    const msg = error.response
      ? JSON.stringify(error.response.data)
      : error.message;
    console.error("HuggingFace API Error:", msg);
    throw new Error("Erro na API HuggingFace: " + msg);
  }
}

async function callCategorizationApi(pdfBuffer) {
  const payload = {
    encoded_content: pdfBuffer.toString("base64"),
    content_type: "pdf",
    headers: [], // Required by Pydantic model, even if empty
  };
  try {
    const res = await axios.post(`${API_BASE_URL}/categorize`, payload, {
      timeout: 60000, // Categoria deve ser mais rápida
      headers: { "Content-Type": "application/json" },
    });
    return res.data.category; // Assuming the LLM returns {"category": "CATEGORY_NAME"}
  } catch (error) {
    const msg = error.response
      ? JSON.stringify(error.response.data)
      : error.message;
    console.error("HuggingFace Categorization API Error:", msg);
    throw new Error("Erro na API HuggingFace (Categorização): " + msg);
  }
}

async function listPdfsInDriveFolder(drive, folderId) {
  const q = `'${folderId}' in parents and mimeType='application/pdf' and trashed=false`;
  const res = await drive.files.list({
    q: q,
    fields: 'files(id, name, webViewLink)',
    pageSize: 1000, // Adjust as needed
  });
  return res.data.files;
}

async function downloadDrivePdfContent(drive, fileId) {
  const res = await drive.files.get(
    { fileId: fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data);
}

async function direcionarArquivoAposProcessamento(
  drive,
  fileId,
  fileName,
  fullRowData,
  fullHeaders,
  aprovado,
) {
  const pastaId = aprovado ? ID_PASTA_APROVADOS : ID_PASTA_REPROVADOS;
  if (!pastaId) return;
  try {
    const file = await drive.files.get({ fileId, fields: "parents" });
    const previousParents = file.data.parents.join(",");
    await drive.files.update({
      fileId,
      addParents: pastaId,
      removeParents: previousParents,
    });
    console.log(`  > File ${fileName} moved.`);
    const txtContent = fullHeaders
      .map((h, i) => `${h}: ${fullRowData[i] || ""}`)
      .join("\n");
    const txtFileName = fileName.replace(/\.pdf$/i, "") + ".txt";
    const {
      data: { files },
    } = await drive.files.list({
      q: `'${pastaId}' in parents and name = '${txtFileName}' and trashed = false`,
      fields: "files(id)",
    });
    if (files.length === 0) {
      await drive.files.create({
        resource: {
          name: txtFileName,
          parents: [pastaId],
          mimeType: "text/plain",
        },
        media: { mimeType: "text/plain", body: txtContent },
      });
      console.log(`  > Metadata file '${txtFileName}' created.`);
    }
  } catch (e) {
    console.error("  > Drive archival error: " + e.message);
  }
}

async function colorirLinhaUnica(sheets, rowReal, isAprovado, isRejeitado) {
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
  });
  const sheet = spreadsheet.data.sheets.find(
    (s) => s.properties.title === SHEET_NAME,
  );
  if (!sheet) return console.error(`Sheet '${SHEET_NAME}' not found.`);
  const cor = isAprovado
    ? { red: 0.415, green: 0.658, blue: 0.309 }
    : isRejeitado
      ? { red: 0.8, green: 0, blue: 0 }
      : { red: 1, green: 0.85, blue: 0.4 };
  const request = {
    updateCells: {
      range: {
        sheetId: sheet.properties.sheetId,
        startRowIndex: rowReal - 1,
        endRowIndex: rowReal,
      },
      rows: [{ values: [{ userEnteredFormat: { backgroundColor: cor } }] }],
      fields: "userEnteredFormat.backgroundColor",
    },
  };
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: { requests: [request] },
    });
  } catch (e) {
    console.error(`  > Error coloring row ${rowReal}: ${e.message}`);
  }
}

// --- MAIN LOGIC ---
async function processarUmaLinha(
  rowReal,
  row,
  headers,
  llmOutputHeaders,
  sheets,
  drive,
  colAprovacaoIndex,
  colRejeicaoIndex,
  colUrlDocumentoIndex,
  colFeedbackCuradorIndex,
  colInicioDadosApiIndex,
) {
  console.log(`\nProcessing row ${rowReal}...`);
  const urlValue = row[colUrlDocumentoIndex] || "";
  const fileId = getDriveIdFromUrl(urlValue);
  try {
    // Update a placeholder in the sheet (e.g., the first LLM output column)
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!${colIndexToA1(colInicioDadosApiIndex)}${rowReal}`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [["Enviando para API..."]] },
    });
    if (!fileId) throw new Error("Invalid Drive URL.");

    const { data: fileMetadata } = await drive.files.get({
      fileId,
      fields: "name, parents",
    });
    const { data: fileResponse } = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" },
    );
    const pdfBuffer = Buffer.from(fileResponse);

    // Identifica a categoria da coluna AJ (índice 35) ou pelo header "CATEGORIA"
    let colCategoriaIndex = headers.indexOf("CATEGORIA");
    if (colCategoriaIndex === -1) colCategoriaIndex = 35; // Fallback para AJ
    const categoryValue = row[colCategoriaIndex] || null;

    const extractedData = await callCustomCuradorApi(
      pdfBuffer,
      llmOutputHeaders,
      categoryValue
    );

    // Prepare data for updating LLM output columns
    const llmOutputUpdates = [];
    let currentLlmOutputCol = colInicioDadosApiIndex;
    llmOutputHeaders.forEach((header) => {
      const value =
        extractedData[header] !== undefined ? extractedData[header] : "N/A";
      // Check if the header exists in the main headers before updating
      const headerIndex = headers.indexOf(header);
      if (headerIndex !== -1) {
        llmOutputUpdates.push({
          range: `'${SHEET_NAME}'!${colIndexToA1(headerIndex)}${rowReal}`,
          values: [[value]],
        });
        row[headerIndex] = value; // Update the local row object
      }
    });

    // Execute batch update for all LLM output fields
    if (llmOutputUpdates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          data: llmOutputUpdates, // This 'data' property expects an array of ValueRange objects
          valueInputOption: "USER_ENTERED", // Moved here
        },
      });
    }

    const boolAprovado = normalizarBooleano(
      extractedData["APROVAÇÃO CURADOR (marcar)"] || extractedData["aprovacao"],
    );
    const feedbackCurador =
      extractedData["FEEDBACK DO CURADOR (escrever)"] || "N/A";

    // Atualiza a coluna de APROVAÇÃO
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!${colIndexToA1(colAprovacaoIndex)}${rowReal}`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [[boolAprovado ? "TRUE" : "FALSE"]] },
    });
    row[colAprovacaoIndex] = boolAprovado ? "TRUE" : "FALSE";

    // Atualiza a coluna de REJEIÇÃO
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!${colIndexToA1(colRejeicaoIndex)}${rowReal}`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [[!boolAprovado ? "TRUE" : "FALSE"]] },
    });
    row[colRejeicaoIndex] = !boolAprovado ? "TRUE" : "FALSE";

    // Atualiza a coluna de Feedback do Curador
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!${colIndexToA1(colFeedbackCuradorIndex)}${rowReal}`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [[feedbackCurador]] },
    });
    row[colFeedbackCuradorIndex] = feedbackCurador;

    await direcionarArquivoAposProcessamento(
      drive,
      fileId,
      fileMetadata.name,
      row,
      headers,
      boolAprovado,
    );
    await colorirLinhaUnica(sheets, rowReal, boolAprovado, !boolAprovado);

    return { success: true, updatedRow: row };
  } catch (e) {
    console.error(`  > ERROR on row ${rowReal}: ${e.message}`);
    const errorMessage = `ERRO: ${e.message.substring(0, 500)}`;
    // Update the starting LLM output column with the error message
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!${colIndexToA1(colInicioDadosApiIndex)}${rowReal}`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [[errorMessage]] },
    });

    // Atualiza o objeto 'row' para refletir o erro e retorna
    if (row.length > colInicioDadosApiIndex) {
      row[colInicioDadosApiIndex] = errorMessage;
    } else {
      while (row.length <= colInicioDadosApiIndex) {
        row.push("");
      }
      row[colInicioDadosApiIndex] = errorMessage;
    }
    // Also mark as rejected if there was an error
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!${colIndexToA1(colAprovacaoIndex)}${rowReal}`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [["FALSE"]] },
    });
    row[colAprovacaoIndex] = "FALSE";
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!${colIndexToA1(colRejeicaoIndex)}${rowReal}`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [["TRUE"]] },
    });
    row[colRejeicaoIndex] = "TRUE";
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!${colIndexToA1(colFeedbackCuradorIndex)}${rowReal}`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [[`Erro na análise: ${errorMessage}`]] },
    });
    row[colFeedbackCuradorIndex] = `Erro na análise: ${errorMessage}`;

    await colorirLinhaUnica(sheets, rowReal, false, true); // Color as rejected
    return { success: false, updatedRow: row };
  }
}

async function executarCuradoriaLocalmente() {
  const { sheets, drive } = await getAuthenticatedServices();
  // Fetch a wider range to ensure all possible headers are included
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${SHEET_NAME}'!1:1`,
  });
  const headers = data.values ? data.values[0] : [];
  if (headers.length === 0) throw new Error("No headers found in sheet.");

  const colAprovacaoIndex = headers.indexOf("APROVAÇÃO CURADOR (marcar)");
  const colRejeicaoIndex = headers.indexOf("ARTIGOS REJEITADOS");
  const colUrlDocumentoIndex = headers.indexOf("URL DO DOCUMENTO");
  const colFeedbackCuradorIndex = headers.indexOf(
    "FEEDBACK DO CURADOR (escrever)",
  );
  // Find the starting column for LLM outputs. Assuming it's the first LLM field.
  const colInicioDadosApiIndex = headers.indexOf(ALL_METADATA_FIELDS[0]);

  if (
    colAprovacaoIndex === -1 ||
    colRejeicaoIndex === -1 ||
    colUrlDocumentoIndex === -1 ||
    colFeedbackCuradorIndex === -1 ||
    colInicioDadosApiIndex === -1
  ) {
    throw new Error(
      "Colunas essenciais para curadoria ('APROVAÇÃO CURADOR (marcar)', 'ARTIGOS REJEITADOS', 'URL DO DOCUMENTO', 'FEEDBACK DO CURADOR (escrever)', e o primeiro campo de metadados) não encontradas na planilha. Verifique os cabeçalhos da planilha.",
    );
  }

  // Fetch all data now that we know the headers
  const { data: allData } = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${SHEET_NAME}'!A:ZZ`,
  });
  const dataRows = allData.values.slice(1); // Exclude headers

  let processados = 0,
    erros = 0;

  for (const [i, row] of dataRows.entries()) {
    const isApproved =
      (row[colAprovacaoIndex] || "").toString().trim().toUpperCase() === "TRUE";
    const isRejected =
      (row[colRejeicaoIndex] || "").toString().trim().toUpperCase() === "TRUE";
    const hasValidUrl = (row[colUrlDocumentoIndex] || "").startsWith("http");

    if (!isApproved && !isRejected && hasValidUrl) {
      const result = await processarUmaLinha(
        i + 2, // Real row number in sheet
        row,
        headers,
        ALL_METADATA_FIELDS, // llmOutputHeaders (all metadata fields the LLM should output)
        sheets,
        drive,
        colAprovacaoIndex,
        colRejeicaoIndex,
        colUrlDocumentoIndex,
        colFeedbackCuradorIndex,
        colInicioDadosApiIndex,
      );
      result.success ? processados++ : erros++;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return {
    message: `Batch process finished. Processed: ${processados} | Errors: ${erros}`,
  };
}

async function executarCuradoriaLinhaUnica(rowNumber) {
  if (rowNumber < 2) throw new Error("Row number must be 2 or greater.");
  const { sheets, drive } = await getAuthenticatedServices();
  // Fetch headers and the specific row data
  const { data } = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: SPREADSHEET_ID,
    ranges: [
      `'${SHEET_NAME}'!1:1`,
      `'${SHEET_NAME}'!A${rowNumber}:ZZ${rowNumber}`,
    ],
  });

  if (!data.valueRanges || data.valueRanges.length < 2) {
    throw new Error(
      `Não foi possível encontrar dados para o cabeçalho ou para a linha ${rowNumber}. A planilha pode estar vazia ou a linha não existe.`,
    );
  }

  // Defensive validations: ensure the expected 'values' arrays exist
  const vr = data.valueRanges;
  if (!vr[0].values || vr[0].values.length === 0) {
    throw new Error(`Cabeçalho da planilha não encontrado ou vazio.`);
  }
  if (!vr[1].values || vr[1].values.length === 0) {
    throw new Error(`A linha ${rowNumber} não contém valores ou está vazia.`);
  }

  const headers = vr[0].values[0];
  const row = vr[1].values[0];

  const colAprovacaoIndex = headers.indexOf("APROVAÇÃO CURADOR (marcar)");
  const colRejeicaoIndex = headers.indexOf("ARTIGOS REJEITADOS");
  const colUrlDocumentoIndex = headers.indexOf("URL DO DOCUMENTO");
  const colFeedbackCuradorIndex = headers.indexOf(
    "FEEDBACK DO CURADOR (escrever)",
  );
  // Find the starting column for LLM outputs. Assuming it's the first LLM field.
  const colInicioDadosApiIndex = headers.indexOf(ALL_METADATA_FIELDS[0]);

  if (
    colAprovacaoIndex === -1 ||
    colRejeicaoIndex === -1 ||
    colUrlDocumentoIndex === -1 ||
    colFeedbackCuradorIndex === -1 ||
    colInicioDadosApiIndex === -1
  ) {
    throw new Error(
      "Colunas essenciais para curadoria ('APROVAÇÃO CURADOR (marcar)', 'ARTIGOS REJEITADOS', 'URL DO DOCUMENTO', 'FEEDBACK DO CURADOR (escrever)', e o primeiro campo de metadados) não encontradas na planilha. Verifique os cabeçalhos da planilha.",
    );
  }

  const { success, updatedRow } = await processarUmaLinha(
    rowNumber,
    row,
    headers,
    ALL_METADATA_FIELDS, // llmOutputHeaders
    sheets,
    drive,
    colAprovacaoIndex,
    colRejeicaoIndex,
    colUrlDocumentoIndex,
    colFeedbackCuradorIndex,
    colInicioDadosApiIndex,
  );

  const articleObject = { __row_number: rowNumber };
  headers.forEach((h, i) => {
    articleObject[h] = updatedRow[i] || "";
  });

  if (success) {
    return {
      message: `Row ${rowNumber} processed successfully.`,
      updatedArticle: articleObject,
    };
  }
  return {
    message: `Failed to process row ${rowNumber}.`,
    updatedArticle: articleObject,
  };
}

async function executarCategorizacaoLinhaUnica(rowNumber) {
  if (rowNumber < 2) throw new Error("Row number must be 2 or greater.");
  const { sheets, drive } = await getAuthenticatedServices();

  const { data } = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: SPREADSHEET_ID,
    ranges: [`'${SHEET_NAME}'!1:1`, `'${SHEET_NAME}'!A${rowNumber}:ZZ${rowNumber}`],
  });

  if (!data.valueRanges || data.valueRanges.length < 2 || !data.valueRanges[1].values) {
    throw new Error("Não foi possível encontrar a linha solicitada.");
  }

  const headers = data.valueRanges[0].values[0];
  const row = data.valueRanges[1].values[0];

  const colUrlDocumentoIndex = headers.indexOf("URL DO DOCUMENTO");
  let colCategoriaIndex = headers.indexOf("CATEGORIA");
  if (colCategoriaIndex === -1) colCategoriaIndex = 35; // Fallback

  const urlValue = row[colUrlDocumentoIndex] || "";
  const fileId = getDriveIdFromUrl(urlValue);

  if (!fileId) throw new Error("Este artigo não possui um documento válido para categorização.");

  const { data: fileResponse } = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  const pdfBuffer = Buffer.from(fileResponse);

  const category = await callCategorizationApi(pdfBuffer);

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${SHEET_NAME}'!${colIndexToA1(colCategoriaIndex)}${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    resource: { values: [[category]] },
  });

  const updatedRow = [...row];
  updatedRow[colCategoriaIndex] = category;

  const articleObject = { __row_number: rowNumber };
  headers.forEach((h, i) => {
    articleObject[h] = updatedRow[i] || "";
  });

  return {
    message: `Artigo da linha ${rowNumber} categorizado como ${category}.`,
    updatedArticle: articleObject,
  };
}

async function processDriveFolderForBatchInsert(folderId) {
  const { sheets, drive } = await getAuthenticatedServices();

  const { data: headerData } = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${SHEET_NAME}'!1:1`,
  });
  const headers = headerData.values ? headerData.values[0] : [];
  if (headers.length === 0) throw new Error("No headers found in sheet.");

  const pdfFiles = await listPdfsInDriveFolder(drive, folderId);
  if (!pdfFiles || pdfFiles.length === 0) {
    return { message: "Nenhum arquivo PDF encontrado na pasta do Google Drive." };
  }

  const articlesToUpload = [];
  let processedCount = 0;
  let errorCount = 0;

  for (const file of pdfFiles) {
    try {
      const pdfBuffer = await downloadDrivePdfContent(drive, file.id);
      
      const category = await callCategorizationApi(pdfBuffer);
      
      const extractedMetadata = await callCustomCuradorApi(pdfBuffer, ALL_METADATA_FIELDS);

      const rowData = {};
      ALL_METADATA_FIELDS.forEach(field => {
        rowData[field] = extractedMetadata[field] || "N/A";
      });
      rowData["CATEGORIA"] = category; // Add the categorized value
      rowData["URL DO DOCUMENTO"] = file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`;
      rowData["Título"] = extractedMetadata["Titulo"] || file.name.replace(/\.pdf$/i, ''); // Use extracted title or filename

      articlesToUpload.push(rowData);
      processedCount++;

    } catch (e) {
      console.error(`Error processing file ${file.name} (${file.id}): ${e.message}`);
      errorCount++;
    }
  }

  if (articlesToUpload.length > 0) {
    const success = await uploadToGsheets(sheets, articlesToUpload);
    if (success) {
      return {
        message: `Processamento em lote concluído. Total: ${pdfFiles.length}, Processados com sucesso: ${processedCount}, Com erros: ${errorCount}. Dados inseridos na planilha.`,
        processedCount,
        errorCount,
      };
    } else {
      throw new Error("Falha ao inserir os dados na planilha.");
    }
  } else {
    return {
      message: `Processamento em lote concluído. Total: ${pdfFiles.length}, Nenhum artigo elegível para upload.`,
      processedCount,
      errorCount,
    };
  }
}

async function getCuratedArticles() {
  const { sheets } = await getAuthenticatedServices();
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${SHEET_NAME}'!A:ZZ`,
  }); // Fetch wider range for all headers
  if (!data.values || data.values.length < 2) return [];
  const [headers, ...rows] = data.values;
  return rows.map((row, index) => {
    const article = { __row_number: index + 2 };
    headers.forEach((header, i) => {
      article[header] = row[i] || "";
    });
    return article;
  });
}

const reconstructAbstract = (invertedIndex) => {
  if (!invertedIndex) return "";
  const wordIndex = Object.entries(invertedIndex).flatMap(([word, positions]) =>
    positions.map((pos) => [pos, word]),
  );
  wordIndex.sort((a, b) => a[0] - b[0]);
  return wordIndex.map(([, word]) => word).join(" ");
};

async function searchOpenAlex(
  searchExpression,
  startYear,
  endYear,
  sortOption = "relevance",
) {
  let sortParam = "relevance_score:desc";

  if (sortOption === "newest") {
    sortParam = "publication_year:desc";
  } else if (sortOption === "cited") {
    sortParam = "cited_by_count:desc";
  }

  const params = {
    filter: `title_and_abstract.search:${searchExpression},publication_year:${startYear}-${endYear}`,
    sort: sortParam,
    "per-page": 200,
    cursor: "*",
    mailto: EMAIL_CONTATO,
  };
  const allWorks = [];
  while (true) {
    try {
      const { data } = await axios.get("https://api.openalex.org/works", {
        params,
      });
      if (data.results.length === 0) break;
      allWorks.push(...data.results);
      if (!data.meta.next_cursor || allWorks.length >= 400) break;
      params.cursor = data.meta.next_cursor;
    } catch (error) {
      console.error("OpenAlex search error:", error.message);
      break;
    }
  }
  return allWorks.map((work) => ({
    id: work.id,
    work_id: work.id,
    pdf_url: work.best_oa_location?.pdf_url,
    authors: (work.authorships || [])
      .map((a) => a.author?.display_name || "")
      .join(", "),
    title: work.title || "",
    year: work.publication_year || "",
    cited_by_count: work.cited_by_count || 0,
    abstract: reconstructAbstract(work.abstract_inverted_index),
    type: work.type || "",
    doi: (work.doi || "").replace("https://doi.org/", ""),
    source:
      work.host_venue?.display_name ||
      work.primary_location?.source?.display_name ||
      "",
  }));
}

async function saveData(selectedRows) {
  const { drive, sheets } = await getAuthenticatedServices();
  const tempDir = path.join(__dirname, "temp_downloads_web");
  await fs.mkdir(tempDir, { recursive: true });
  const finalDataToUpload = [];

  for (const [i, rowData] of selectedRows.entries()) {
    let finalDriveUrl = rowData["URL Original"] || rowData.doi;
    if (rowData.pdf_url) {
      const docId = (rowData.work_id || `unknown-${i}`).split("/").pop();
      const filename = path.join(tempDir, `${docId}.pdf`);
      try {
        const response = await axios.get(rowData.pdf_url, {
          responseType: "stream",
          timeout: 30000,
        });
        const writer = fsSync.createWriteStream(filename);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
          writer.on("finish", resolve);
          writer.on("error", reject);
        });
        const driveLink = await uploadFileToDrive(
          drive,
          filename,
          `${docId}.pdf`,
        );
        if (driveLink) finalDriveUrl = driveLink;
        await fs.unlink(filename);
      } catch (err) {
        console.error(
          `Failed to download/upload ${rowData.pdf_url}:`,
          err.message,
        );
      }
    }
    finalDataToUpload.push({
      id: rowData.id,
      ...rowData,
      "URL DO DOCUMENTO": finalDriveUrl,
    });
  }

  if (finalDataToUpload.length > 0) {
    const success = await uploadToGsheets(sheets, finalDataToUpload);
    return {
      status: success ? "success" : "error",
      message: success
        ? `${finalDataToUpload.length} records saved!`
        : "Failed to save.",
    };
  }
  return { status: "info", message: "No data to save." };
}

async function uploadToGsheets(sheets, data) {
  try {
    const {
      data: { values },
    } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!1:1`,
    });
    const headers = values ? values[0] : [];
    if (headers.length === 0) throw new Error("No headers found in sheet.");

    const finalValues = data.map((row) => {
      const newRow = new Array(headers.length).fill("");
      headers.forEach((h, i) => {
        if (row[h] !== undefined) newRow[i] = String(row[h]);
      });
      return newRow;
    });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'`,
      valueInputOption: "USER_ENTERED",
      resource: { values: finalValues },
    });
    return true;
  } catch (error) {
    console.error("ERROR Sheets:", error.message);
    return false;
  }
}

/**
 * Inserts a single record manually into the Google Sheet.
 * @param {object} data The article data from the frontend form.
 * @returns {Promise<{status: string, message: string}>}
 */
async function manualInsert(data) {
  const { sheets } = await getAuthenticatedServices();

  const rowToUpload = {
    "Autor(es)": data["Autor(es)"],
    "Título": data.Titulo,
    "Subtítulo": data.Subtítulo,
    "Ano": data.Ano,
    "Número de citações recebidas (Google Scholar)":
      data["Número de citações recebidas (Google Scholar)"],
    "Palavras-chave": data["Palavras-chave"],
    "Resumo": data.Resumo,
    "Tipo de documento": data["Tipo de documento"],
    "Editora": data.Editora,
    "Instituição": data.Instituição,
    "Local": data.Local,
    "Tipo de trabalho": data["Tipo de trabalho"],
    "Título do periódico": data["Título do periódico"],
    "Quartil do periódico": data["Quartil do periódico"],
    "Volume": data.Volume,
    "Número/fascículo": data["Número/fascículo"],
    "Páginas": data.Páginas,
    "DOI": data.DOI,
    "Numeração": data.Numeração,
    "Qualis": data.Qualis,
    "CATEGORIA": data.CATEGORIA,
    "Caracteristicas do solo e região (escrever)":
      data["Caracteristicas do solo e região (escrever)"],
    "ferramentas e técnicas (seleção)":
      data["ferramentas e técnicas (seleção)"],
    "nutrientes (seleção)": data["nutrientes (seleção)"],
    "estratégias de fornecimento de nutrientes (seleção)":
      data["estratégias de fornecimento de nutrientes (seleção)"],
    "grupos de culturas (seleção)": data["grupos de culturas (seleção)"],
    "culturas presentes (seleção)": data["culturas presentes (seleção)"],
    "FEEDBACK DO CURADOR (escrever)": data["FEEDBACK DO CURADOR (escrever)"],
    "URL DO DOCUMENTO": data.pub_url,
    "work_id": data.id || `manual-${Date.now()}`,
  };

  const success = await uploadToGsheets(sheets, [rowToUpload]);

  if (success) {
    return {
      status: "success",
      message: "Documento inserido com sucesso na planilha!",
    };
  } else {
    return {
      status: "error",
      message: "Falha ao salvar os dados na planilha.",
    };
  }
}

async function downloadPdfTemp(url, filename) {
  try {
    const writer = fsSync.createWriteStream(filename);
    const response = await axios({
      url,
      method: "GET",
      responseType: "stream",
      timeout: 30000,
    });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });
  } catch (error) {
    console.error(` > Download error for ${url}:`, error.message);
    return false;
  }
}

async function uploadFileToDrive(drive, filepath, filename) {
  try {
    const { data } = await drive.files.create({
      resource: { name: filename, parents: [DRIVE_FOLDER_ID] },
      media: {
        mimeType: "application/pdf",
        body: fsSync.createReadStream(filepath),
      },
      fields: "id, webViewLink",
    });
    return data.webViewLink;
  } catch (error) {
    console.error(` > Google Drive upload error:`, error.message);
    return null;
  }
}

async function deleteRow(rowNumber) {
  if (rowNumber < 2) throw new Error("Row number must be 2 or greater.");
  const { sheets } = await getAuthenticatedServices();

  // Google Sheets API uses 0-based index. Row 1 is index 0.
  // rowNumber is 1-based (from UI/Excel).
  const startIndex = rowNumber - 1;
  const endIndex = rowNumber;

  const request = {
    deleteDimension: {
      range: {
        sheetId: await getSheetId(sheets),
        dimension: "ROWS",
        startIndex: startIndex,
        endIndex: endIndex,
      },
    },
  };

  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: { requests: [request] },
    });
    return { success: true, message: `Row ${rowNumber} deleted successfully.` };
  } catch (error) {
    console.error(`Error deleting row ${rowNumber}:`, error.message);
    throw new Error(`Failed to delete row ${rowNumber}: ${error.message}`);
  }
}

async function deleteUnavailableRows() {
  const { sheets } = await getAuthenticatedServices();
  const sheetId = await getSheetId(sheets);

  // Fetch all data to identify unavailable rows
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${SHEET_NAME}'!A:AI`,
  });

  if (!data.values || data.values.length < 2)
    return { message: "No data to process." };

  const [headers, ...rows] = data.values;

  // Find column index for "URL DO DOCUMENTO" or fallback to COL_URL_PDF logic
  let urlColIndex = headers.indexOf("URL DO DOCUMENTO");

  // If column not found by name, assume it might be one of the known columns or check logic
  // In CurationPage: unavailable if "URL DO DOCUMENTO" is empty.
  if (urlColIndex === -1) {
    console.warn(
      "Column 'URL DO DOCUMENTO' not found in headers. checking COL_URL_PDF (Column V)",
    );
    // Fallback to checking the input PDF column (index 21 -> Col V) if output column missing
    // But usually we save to "URL DO DOCUMENTO".
  }

  const rowsToDelete = [];

  rows.forEach((row, index) => {
    const rowIndexReal = index + 2; // +2 because index 0 is row 2 (after header)

    let isUnavailable = false;

    if (urlColIndex !== -1) {
      const val = row[urlColIndex];
      if (!val || val.toString().trim() === "") {
        isUnavailable = true;
      }
    } else {
      // Fallback: If we can't find the specific column, maybe check the PDF URL input
      // defined as COL_URL_PDF = 22 (index 21) in the file top
      const val = row[21]; // Column V
      if (!val || val.toString().trim() === "") {
        isUnavailable = true;
      }
    }

    if (isUnavailable) {
      rowsToDelete.push(rowIndexReal);
    }
  });

  if (rowsToDelete.length === 0) {
    return { message: "No unavailable rows found to delete." };
  }

  // Sort descending to delete from bottom up
  rowsToDelete.sort((a, b) => b - a);

  const requests = rowsToDelete.map((rowNum) => ({
    deleteDimension: {
      range: {
        sheetId: sheetId,
        dimension: "ROWS",
        startIndex: rowNum - 1,
        endIndex: rowNum,
      },
    },
  }));

  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: { requests: requests },
    });
    return {
      success: true,
      message: `Successfully deleted ${rowsToDelete.length} unavailable rows.`,
    };
  } catch (error) {
    console.error("Error batch deleting rows:", error.message);
    throw new Error("Failed to delete unavailable rows.");
  }
}

async function getSheetId(sheets) {
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
  });
  const sheet = spreadsheet.data.sheets.find(
    (s) => s.properties.title === SHEET_NAME,
  );
  if (!sheet) throw new Error(`Sheet '${SHEET_NAME}' not found.`);
  return sheet.properties.sheetId;
}

async function aprovarManualmente(rowNumber, fileId) {
  const { drive, sheets } = await getAuthenticatedServices();

  if (!fileId) {
    throw new Error(
      "O artigo não possui um arquivo no Drive para ser copiado.",
    );
  }

  try {
    // Get file name before copying
    const fileMetadata = await drive.files.get({
      fileId: fileId,
      fields: "name",
    });
    const fileName = fileMetadata.data.name;

    // 1. Copia o arquivo para a pasta de aprovados
    await drive.files.copy({
      fileId: fileId,
      resource: {
        name: fileName,
        parents: [ID_PASTA_APROVADOS],
      },
    });

    // 2. Atualiza a planilha para marcar como "APROVAÇÃO MANUAL" = TRUE
    // Busca pelo índice do cabeçalho 'APROVAÇÃO MANUAL' para ser resiliente a mudanças de coluna
    const headerResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!1:1`,
    });
    const headers = headerResp.data.values ? headerResp.data.values[0] : [];
    const aprovIndex = headers.indexOf("APROVAÇÃO MANUAL");
    const targetCol = aprovIndex !== -1 ? colIndexToA1(aprovIndex) : "AI";

    const range = `'${SHEET_NAME}'!${targetCol}${rowNumber}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: range,
      valueInputOption: "USER_ENTERED",
      resource: {
        values: [["TRUE"]],
      },
    });

    return {
      success: true,
      message: `Artigo da linha ${rowNumber} aprovado manualmente e copiado.`,
    };
  } catch (error) {
    console.error(
      `Erro na aprovação manual da linha ${rowNumber}:`,
      error.message,
    );
    throw new Error(`Falha ao aprovar manualmente o artigo: ${error.message}`);
  }
}

module.exports = {
  searchOpenAlex,
  saveData,
  getCuratedArticles,
  executarCuradoriaLocalmente,
  executarCuradoriaLinhaUnica,
  executarCategorizacaoLinhaUnica,
  deleteRow,
  deleteUnavailableRows,
  manualInsert, // Exporta a nova função
  aprovarManualmente,
  getAuthenticatedServices,
  uploadFileToDrive,
  processDriveFolderForBatchInsert, // Export the new function
};

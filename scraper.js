// scraper.js
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const XLSX = require('xlsx');

// Obtener variables de entorno
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'uai-salas';
const COLLECTION_NAME = 'eventos';
const ALL_EVENTOS_COLLECTION = 'all_eventos'; // Nueva colección

async function main() {
  console.log('🚀 Iniciando proceso de scraping...');
  
  // Crear carpeta para descargas si no existe
  const downloadPath = path.join(process.cwd(), 'downloads');
  if (!fs.existsSync(downloadPath)) {
    fs.mkdirSync(downloadPath, { recursive: true });
  }
  
  console.log(`📂 Carpeta de descargas: ${downloadPath}`);

  // Iniciar el navegador con Puppeteer
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    
    // Configurar el manejo de descargas
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadPath,
    });

    console.log('🌐 Navegando a hoy.uai.cl...');
    await page.goto('https://hoy.uai.cl/', { waitUntil: 'networkidle2' });
    console.log('✅ Página cargada correctamente');
    
    // Esperar a que la página cargue completamente
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Hacer clic en el botón de descarga
    console.log('🔍 Buscando el botón de descarga...');
    const buttonClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const downloadButton = buttons.find(btn => btn.textContent.includes('Descargar Excel'));
      if (downloadButton) {
        console.log('Botón encontrado, haciendo clic...');
        downloadButton.click();
        return true;
      }
      return false;
    });

    if (!buttonClicked) {
      throw new Error('No se encontró el botón de descarga');
    }

    console.log('⌛ Esperando que el archivo se descargue...');

    // Esperar a que el archivo se descargue
    let filePath = '';
    let attempts = 0;
    while (attempts < 30) { // Esperamos hasta 30 segundos
      const files = fs.readdirSync(downloadPath);
      const excelFile = files.find(file => file.endsWith('.xlsx'));

      if (excelFile) {
        filePath = path.join(downloadPath, excelFile);
        console.log(`📄 Archivo Excel descargado: ${excelFile}`);
        break;
      }

      attempts++;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!filePath) {
      throw new Error('No se encontró el archivo Excel después de esperar la descarga');
    }

    // Leer el archivo Excel
    console.log('📊 Procesando el archivo Excel...');
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(worksheet);

    console.log(`📈 Se encontraron ${jsonData.length} eventos en el Excel`);

    // Guardar en MongoDB
    if (MONGODB_URI) {
      await saveToMongoDB(jsonData);
    } else {
      console.log('⚠️ No se configuró MONGODB_URI, omitiendo guardado en base de datos');
    }

    console.log('✅ Proceso completado exitosamente');
    return { success: true, eventsCount: jsonData.length };
  } catch (error) {
    console.error('❌ Error durante el proceso:', error);
    throw error;
  } finally {
    await browser.close();
    console.log('🔒 Navegador cerrado');
  }
}

async function saveToMongoDB(events) {
  console.log('🔌 Conectando a MongoDB...');
  const client = new MongoClient(MONGODB_URI);
  
  try {
    await client.connect();
    console.log('✅ Conexión exitosa a MongoDB');
    
    const db = client.db(DB_NAME);
    const collection = db.collection(COLLECTION_NAME);
    const allEventosCollection = db.collection(ALL_EVENTOS_COLLECTION);
    
    // Añadir fecha de actualización a los eventos
    const today = new Date().toISOString().split('T')[0];
    const eventsWithDate = events.map(event => ({
      ...event,
      fechaActualizacion: today
    }));
    
    // Eliminar eventos anteriores con la misma fecha (solo para la colección original)
    await collection.deleteMany({ fechaActualizacion: today });
    console.log(`🗑️ Eventos antiguos eliminados para la fecha ${today} en colección ${COLLECTION_NAME}`);
    
    // Insertar nuevos eventos en la colección original
    const result = await collection.insertMany(eventsWithDate);
    console.log(`✅ ${result.insertedCount} eventos guardados en colección ${COLLECTION_NAME}`);
    
    // Filtrar solo Cátedras y Ayudantías para la colección all_eventos
    const catedrasYAyudantias = eventsWithDate.filter(event => 
      event.Tipo === "Cátedra" || event.Tipo === "Ayudantía"
    );
    
    // Preparar datos simplificados para all_eventos (solo los campos requeridos)
    const simplifiedEvents = catedrasYAyudantias.map(event => ({
      Evento: event.Evento,
      Inicio: event.Inicio,
      Fin: event.Fin,
      Tipo: event.Tipo,
      fechaActualizacion: event.fechaActualizacion
    }));
    
    // Insertar eventos filtrados en all_eventos (sin borrar datos previos)
    if (simplifiedEvents.length > 0) {
      const allEventosResult = await allEventosCollection.insertMany(simplifiedEvents);
      console.log(`✅ ${allEventosResult.insertedCount} eventos de Cátedra/Ayudantía guardados en colección ${ALL_EVENTOS_COLLECTION}`);
    } else {
      console.log(`ℹ️ No se encontraron eventos de Cátedra/Ayudantía para guardar en ${ALL_EVENTOS_COLLECTION}`);
    }
    
    // Crear índices para búsquedas eficientes en la colección original
    await collection.createIndex({ Evento: 1 });
    await collection.createIndex({ Sala: 1 });
    await collection.createIndex({ Campus: 1 });
    await collection.createIndex({ fechaActualizacion: 1 });
    
    // Crear índices para la nueva colección
    await allEventosCollection.createIndex({ Evento: 1 });
    await allEventosCollection.createIndex({ Tipo: 1 });
    await allEventosCollection.createIndex({ Inicio: 1 });
    await allEventosCollection.createIndex({ Fin: 1 });
    await allEventosCollection.createIndex({ fechaActualizacion: 1 });
    
    console.log('📑 Índices creados correctamente en ambas colecciones');
  } finally {
    await client.close();
    console.log('🔌 Conexión a MongoDB cerrada');
  }
}

// Ejecutar el script
if (require.main === module) {
  main()
    .then(() => {
      console.log('🎉 Script ejecutado correctamente');
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ Error en la ejecución:', error);
      process.exit(1);
    });
}

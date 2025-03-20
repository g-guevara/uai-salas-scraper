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

  // Primero, eliminar todos los datos de la colección 'eventos'
  if (MONGODB_URI) {
    await clearEventsCollection();
  } else {
    console.log('⚠️ No se configuró MONGODB_URI, omitiendo limpieza de la base de datos');
  }

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
      console.log('⚠️ No se encontró el botón de descarga. Probablemente no hay datos disponibles hoy.');
      return { success: true, eventsCount: 0, message: 'No hay datos disponibles hoy' };
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
      console.log('⚠️ No se pudo descargar el archivo Excel. Probablemente no hay datos disponibles.');
      return { success: true, eventsCount: 0, message: 'No se pudo descargar el archivo Excel' };
    }

    // Leer el archivo Excel
    console.log('📊 Procesando el archivo Excel...');
    const workbook = XLSX.readFile(filePath);
    
    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      console.log('⚠️ El archivo Excel no contiene hojas de cálculo.');
      return { success: true, eventsCount: 0, message: 'Excel sin hojas de cálculo' };
    }
    
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    if (!worksheet) {
      console.log('⚠️ No se pudo acceder a la hoja de cálculo.');
      return { success: true, eventsCount: 0, message: 'No se pudo acceder a la hoja de cálculo' };
    }
    
    const jsonData = XLSX.utils.sheet_to_json(worksheet);

    if (!jsonData || jsonData.length === 0) {
      console.log('⚠️ El archivo Excel no contiene datos.');
      return { success: true, eventsCount: 0, message: 'Excel sin datos' };
    }

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
    // No lanzamos el error, solo lo registramos para que el script no falle
    return { success: false, error: error.message };
  } finally {
    await browser.close();
    console.log('🔒 Navegador cerrado');
  }
}

// Obtener el día de la semana en español
function getDiaSemana() {
  const dias = [
    'Domingo', 
    'Lunes', 
    'Martes', 
    'Miércoles', 
    'Jueves', 
    'Viernes', 
    'Sábado'
  ];
  
  const now = new Date();
  return dias[now.getDay()];
}

// Nueva función para eliminar todos los datos de la colección 'eventos'
async function clearEventsCollection() {
  console.log('🗑️ Eliminando todos los datos de la colección eventos...');
  const client = new MongoClient(MONGODB_URI);
  
  try {
    await client.connect();
    console.log('✅ Conexión exitosa a MongoDB para limpieza');
    
    const db = client.db(DB_NAME);
    const collection = db.collection(COLLECTION_NAME);
    
    // Eliminar todos los documentos de la colección
    const result = await collection.deleteMany({});
    console.log(`🗑️ Se eliminaron ${result.deletedCount} eventos de la colección ${COLLECTION_NAME}`);
  } catch (error) {
    console.error('❌ Error al eliminar datos:', error);
    // No lanzamos el error, solo lo registramos para que el script no falle
    console.log('⚠️ Se continuará con el proceso a pesar del error en la limpieza');
  } finally {
    await client.close();
    console.log('🔌 Conexión a MongoDB cerrada después de limpieza');
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
    
    // Insertar nuevos eventos en la colección original
    const result = await collection.insertMany(eventsWithDate);
    console.log(`✅ ${result.insertedCount} eventos guardados en colección ${COLLECTION_NAME}`);
    
    // Obtener el día de la semana actual
    const diaSemana = getDiaSemana();
    console.log(`🗓️ Día de la semana actual: ${diaSemana}`);
    
    // Filtrar solo Cátedras y Ayudantías para la colección all_eventos
    const catedrasYAyudantias = eventsWithDate.filter(event => 
      event.Tipo === "Cátedra" || event.Tipo === "Ayudantía"
    );
    
    console.log(`🔍 Verificando ${catedrasYAyudantias.length} eventos de Cátedra/Ayudantía para evitar duplicados...`);
    
    // Lista para almacenar los eventos que pasarán a la colección all_eventos
    const eventosAGuardar = [];
    
    // Verificar cada evento para ver si ya existe en la colección all_eventos
    for (const event of catedrasYAyudantias) {
      // Crear el objeto de búsqueda con los campos que deben coincidir
      const busqueda = {
        Tipo: event.Tipo,
        Evento: event.Evento,
        Inicio: event.Inicio,
        Fin: event.Fin
      };
      
      // Añadir campos adicionales si existen en el evento
      if (event.Sala) busqueda.Sala = event.Sala;
      if (event.Edificio) busqueda.Edificio = event.Edificio;
      if (event.Campus) busqueda.Campus = event.Campus;
      
      // Consultar si ya existe un evento con estas características
      const eventoExistente = await allEventosCollection.findOne(busqueda);
      
      // Si no existe, lo agregamos a la lista de eventos a guardar
      if (!eventoExistente) {
        eventosAGuardar.push({
          Evento: event.Evento,
          Inicio: event.Inicio,
          Fin: event.Fin,
          Tipo: event.Tipo,
          Sala: event.Sala,
          Edificio: event.Edificio,
          Campus: event.Campus,
          fechaActualizacion: today,
          diaSemana: diaSemana
        });
      }
    }
    
    console.log(`✅ De ${catedrasYAyudantias.length} eventos, ${eventosAGuardar.length} son nuevos y se guardarán en all_eventos`);
    
    // Insertar eventos filtrados en all_eventos (solo los que no existen ya)
    if (eventosAGuardar.length > 0) {
      const allEventosResult = await allEventosCollection.insertMany(eventosAGuardar);
      console.log(`✅ ${allEventosResult.insertedCount} eventos de Cátedra/Ayudantía guardados en colección ${ALL_EVENTOS_COLLECTION}`);
    } else {
      console.log(`ℹ️ No se encontraron nuevos eventos de Cátedra/Ayudantía para guardar en ${ALL_EVENTOS_COLLECTION}`);
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
    await allEventosCollection.createIndex({ diaSemana: 1 });
    await allEventosCollection.createIndex({ Sala: 1 });
    await allEventosCollection.createIndex({ Campus: 1 });
    
    console.log('📑 Índices creados correctamente en ambas colecciones');
  } catch (error) {
    console.error('❌ Error al guardar en MongoDB:', error);
    throw error;
  } finally {
    await client.close();
    console.log('🔌 Conexión a MongoDB cerrada');
  }
}

// Ejecutar el script
if (require.main === module) {
  main()
    .then((result) => {
      console.log('🎉 Script ejecutado correctamente');
      console.log('Resultado:', result);
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ Error en la ejecución:', error);
      process.exit(1);
    });
}

module.exports = { main }; // Exportamos la función main para posibles pruebas

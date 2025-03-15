const axios = require('axios');
const cheerio = require('cheerio');
const { MongoClient } = require('mongodb');

// Configuración
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'uai-salas';
const COLLECTION_NAME = 'eventos';

async function scrapeEvents() {
  console.log('Iniciando proceso de scraping...');
  
  try {
    // Obtener la primera página para determinar número total de páginas
    const { data: firstPageData } = await axios.get('https://hoy.uai.cl/');
    const $firstPage = cheerio.load(firstPageData);
    
    // Determinar número total de páginas
    let totalPages = 1;
    const paginationItems = $firstPage('nav[aria-label="pagination"] ul li a');
    paginationItems.each((i, el) => {
      const pageNum = parseInt($firstPage(el).text().trim());
      if (!isNaN(pageNum) && pageNum > totalPages) {
        totalPages = pageNum;
      }
    });
    
    console.log(`Detectadas ${totalPages} páginas en total`);
    
    // Inicializar array para todos los eventos
    const allEvents = [];
    
    // Procesar eventos de la primera página
    const firstPageEvents = extractEventsFromPage($firstPage);
    allEvents.push(...firstPageEvents);
    console.log(`Extraídos ${firstPageEvents.length} eventos de la página 1`);
    
    // Procesar el resto de páginas
    for (let page = 2; page <= totalPages; page++) {
      console.log(`Procesando página ${page} de ${totalPages}...`);
      
      const { data } = await axios.get(`https://hoy.uai.cl/?page=${page}`);
      const $ = cheerio.load(data);
      
      const pageEvents = extractEventsFromPage($);
      allEvents.push(...pageEvents);
      
      console.log(`Extraídos ${pageEvents.length} eventos de la página ${page}`);
      
      // Pequeña pausa para no sobrecargar el servidor
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log(`Scraping completado. Obtenidos ${allEvents.length} eventos en total.`);
    
    // Añadir fecha a cada evento
    const today = new Date().toISOString().split('T')[0];
    const eventsWithDate = allEvents.map(event => ({
      ...event,
      fechaActualizacion: today
    }));
    
    // Guardar en MongoDB
    await saveToMongoDB(eventsWithDate);
    
    return {
      success: true,
      count: allEvents.length
    };
  } catch (error) {
    console.error('Error en el proceso de scraping:', error);
    throw error;
  }
}

function extractEventsFromPage($) {
  const events = [];
  
  $('table tbody tr').each((i, element) => {
    const columns = $(element).find('td');
    
    if (columns.length >= 6) {
      events.push({
        tipo: $(columns[0]).find('div').text().trim() || 'Sin tipo',
        evento: $(columns[1]).text().trim(),
        sala: $(columns[2]).text().trim(),
        inicio: $(columns[3]).text().trim(),
        fin: $(columns[4]).text().trim(),
        campus: $(columns[5]).text().trim()
      });
    }
  });
  
  return events;
}

async function saveToMongoDB(events) {
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI environment variable is not set');
  }
  
  console.log('Conectando a MongoDB...');
  const client = new MongoClient(MONGODB_URI);
  
  try {
    await client.connect();
    console.log('Conexión exitosa a MongoDB');
    
    const db = client.db(DB_NAME);
    const collection = db.collection(COLLECTION_NAME);
    
    // Eliminar eventos del día anterior
    const today = new Date().toISOString().split('T')[0];
    await collection.deleteMany({ fechaActualizacion: today });
    
    // Insertar nuevos eventos
    const result = await collection.insertMany(events);
    console.log(`${result.insertedCount} eventos guardados en MongoDB`);
    
    // Crear índices para búsquedas eficientes
    await collection.createIndex({ evento: 1 });
    await collection.createIndex({ sala: 1 });
    await collection.createIndex({ campus: 1 });
    
    console.log('Índices creados correctamente');
  } finally {
    await client.close();
    console.log('Conexión a MongoDB cerrada');
  }
}

// Ejecutar el script si se llama directamente
if (require.main === module) {
  scrapeEvents()
    .then(result => {
      console.log('Proceso completado exitosamente:', result);
      process.exit(0);
    })
    .catch(error => {
      console.error('Error en el proceso:', error);
      process.exit(1);
    });
}

module.exports = { scrapeEvents };
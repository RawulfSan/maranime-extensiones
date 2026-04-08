/// <reference path="./manga-provider.d.ts" />

// ============================================================
// Olympus Biblioteca — Seanime Manga Provider
// Web: https://olympusbiblioteca.com
// Idioma: Español
// ============================================================

const BASE = "https://olympusbiblioteca.com"
const DASH = "https://dashboard.olympusbiblioteca.com"

// Cabeceras para simular un navegador real
const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": BASE,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

// Extrae el ID numérico de la URL de portada
// Ej: .../covers/1445/nombre-lg.webp → "1445"
function extractNumericId(coverUrl) {
    const m = coverUrl.match(/\/covers\/(\d+)\//)
    return m ? m[1] : null
}

// Limpia texto quitando espacios sobrantes
function clean(str) {
    return str ? str.replace(/\s+/g, " ").trim() : ""
}

class Provider {

    getSettings() {
        return {
            supportsMultiLanguage: false,
            supportsMultiScanlator: false,
        }
    }

    // ----------------------------------------------------------
    // BÚSQUEDA
    // Obtiene /series (toda la lista está en el HTML) y filtra
    // ----------------------------------------------------------
    async search(opts) {
        const { query } = opts
        const resp = await $http.get(`${BASE}/series`, { headers: HEADERS })
        const html = resp.data

        const results = []

        // Patron: href="/series/SLUG" ... src="...covers/NUMID/FILE-lg.webp" ... alt="TITULO"
        const re = /href="(\/series\/[^"]+)"[^>]*>[\s\S]*?src="(https:\/\/dashboard\.olympusbiblioteca\.com\/storage\/comics\/covers\/\d+\/[^"]+)"[^>]*alt="([^"]+)"/g

        let m
        while ((m = re.exec(html)) !== null) {
            const slug = m[1].replace("/series/", "")
            const image = m[2]
            const title = clean(m[3])

            // Filtrar por query (case-insensitive)
            if (query && !title.toLowerCase().includes(query.toLowerCase())) continue

            const numericId = extractNumericId(image)
            // El ID que usaremos internamente: "numericId|slug"
            const id = numericId ? `${numericId}|${slug}` : slug

            results.push({ id, title, image })
        }

        return { results: results.slice(0, 40) }
    }

    // ----------------------------------------------------------
    // DETALLES DE LA SERIE
    // ----------------------------------------------------------
    async getDetails(id) {
        const slug = id.includes("|") ? id.split("|")[1] : id
        const resp = await $http.get(`${BASE}/series/${slug}`, { headers: HEADERS })
        const html = resp.data

        // Titulo
        const titleM = html.match(/<h1[^>]*>\s*([^<]+)\s*<\/h1>/)
        const title = titleM ? clean(titleM[1]) : slug

        // Portada (xl)
        const imgM = html.match(/src="(https:\/\/dashboard\.olympusbiblioteca\.com\/storage\/comics\/covers\/\d+\/[^"]+xl\.webp)"/)
        const image = imgM ? imgM[1] : ""

        // Estado
        let status = "unknown"
        if (html.includes("Activo")) status = "ongoing"
        else if (html.includes("Finalizado")) status = "completed"
        else if (html.includes("Hiatus")) status = "hiatus"

        return { title, image, status }
    }

    // ----------------------------------------------------------
    // LISTA DE CAPÍTULOS
    // La web los carga dinámicamente. Intentamos el API del
    // dashboard con el ID numérico de la portada.
    // Si falla, devolvemos array vacío con un mensaje claro.
    // ----------------------------------------------------------
    async findChapters(id) {
        const parts = id.split("|")
        const numericId = parts[0]
        const slug = parts[1] || parts[0]

        // Intento 1: API REST del dashboard (patrón Laravel típico)
        try {
            const apiResp = await $http.get(
                `${DASH}/api/comics/${numericId}/chapters`,
                { headers: { ...HEADERS, "Accept": "application/json" } }
            )
            const data = apiResp.data
            if (Array.isArray(data) && data.length > 0) {
                return data.map(ch => ({
                    id: `${ch.id}|${slug}`,
                    title: ch.title || `Capítulo ${ch.number}`,
                    number: parseFloat(ch.number) || 0,
                    date: ch.created_at ? new Date(ch.created_at) : new Date(),
                }))
            }
        } catch (e) { /* sigue al intento 2 */ }

        // Intento 2: buscar en el HTML de la serie (Inertia.js embede JSON en data-page)
        try {
            const pageResp = await $http.get(`${BASE}/series/${slug}`, { headers: HEADERS })
            const html = pageResp.data

            const jsonM = html.match(/data-page="([^"]+)"/)
            if (jsonM) {
                const pageData = JSON.parse(jsonM[1].replace(/&quot;/g, '"'))
                const chapters = pageData?.props?.chapters || pageData?.props?.comic?.chapters || []
                if (Array.isArray(chapters) && chapters.length > 0) {
                    return chapters.map(ch => ({
                        id: `${ch.id}|${slug}`,
                        title: ch.name || `Capítulo ${ch.number}`,
                        number: parseFloat(ch.number) || 0,
                        date: ch.created_at ? new Date(ch.created_at) : new Date(),
                    }))
                }
            }
        } catch (e) { /* sigue */ }

        // Intento 3: parsear /capitulos filtrando por slug de la serie
        try {
            const chapResp = await $http.get(`${BASE}/capitulos`, { headers: HEADERS })
            const html = chapResp.data
            const chapters = []

            const re = new RegExp(
                `href="(/capitulo/(\\d+)/${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})"[^>]*>Capítulo ([\\d.]+)`,
                "g"
            )
            let m
            while ((m = re.exec(html)) !== null) {
                const chapId = m[2]
                const number = parseFloat(m[3])
                chapters.push({
                    id: `${chapId}|${slug}`,
                    title: `Capítulo ${number}`,
                    number,
                    date: new Date(),
                })
            }
            if (chapters.length > 0) return chapters
        } catch (e) { /* sigue */ }

        return []
    }

    // ----------------------------------------------------------
    // PÁGINAS DE UN CAPÍTULO
    // Las imágenes sí están en el HTML directamente → funciona bien
    // ----------------------------------------------------------
    async findChapterPages(id) {
        const [chapId, comicSlug] = id.split("|")
        const url = `${BASE}/capitulo/${chapId}/${comicSlug}`
        const resp = await $http.get(url, { headers: HEADERS })
        const html = resp.data

        const pages = []
        // Patron: src="https://dashboard.olympusbiblioteca.com/storage/comics/ID/CHAPID/FILENAME.webp"
        const re = /src="(https:\/\/dashboard\.olympusbiblioteca\.com\/storage\/comics\/\d+\/\d+\/[^"]+\.webp)"/g
        let m
        let idx = 0
        while ((m = re.exec(html)) !== null) {
            pages.push({ url: m[1], index: idx++ })
        }

        return pages
    }
}

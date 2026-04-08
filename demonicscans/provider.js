/// <reference path="./manga-provider.d.ts" />

// ============================================================
// DemonicScans — Seanime Manga Provider
// Web: https://demonicscans.org
// Idioma: Inglés
// NOTA: El sitio puede devolver 403 sin un User-Agent de
//       navegador. Si falla, contacta al desarrollador del
//       sitio o usa una extensión alternativa.
// ============================================================

const BASE = "https://demonicscans.org"

// Cabeceras para simular navegador real (evitar bloqueo 403)
const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": BASE,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

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
    // Usa /advanced.php con parámetro de búsqueda
    // ----------------------------------------------------------
    async search(opts) {
        const { query } = opts

        // DemonicScans usa advanced.php para búsqueda
        const url = `${BASE}/advanced.php?name=${encodeURIComponent(query)}`
        const resp = await $http.get(url, { headers: HEADERS })
        const html = resp.data

        const results = []

        // Patrón: href="/manga/SLUG" con imagen y título
        const re = /href="(\/manga\/[^"]+)"[^>]*>[\s\S]*?src="([^"]+)"[^>]*alt="([^"]+)"/g
        let m
        while ((m = re.exec(html)) !== null) {
            const slug = m[1].replace("/manga/", "")
            const image = m[2].startsWith("http") ? m[2] : `${BASE}${m[2]}`
            const title = clean(m[3])
            results.push({ id: slug, title, image })
        }

        // Si advanced.php no da resultados, intentar búsqueda en home
        if (results.length === 0) {
            const homeResp = await $http.get(
                `${BASE}/index.php?search=${encodeURIComponent(query)}`,
                { headers: HEADERS }
            )
            const homeHtml = homeResp.data
            const re2 = /href="(\/manga\/[^"]+)"[^>]*>[\s\S]*?src="([^"]+)"[^>]*alt="([^"]+)"/g
            let m2
            while ((m2 = re2.exec(homeHtml)) !== null) {
                const slug = m2[1].replace("/manga/", "")
                const image = m2[2].startsWith("http") ? m2[2] : `${BASE}${m2[2]}`
                const title = clean(m2[3])
                results.push({ id: slug, title, image })
            }
        }

        return { results }
    }

    // ----------------------------------------------------------
    // DETALLES DE LA SERIE
    // ----------------------------------------------------------
    async getDetails(id) {
        const resp = await $http.get(`${BASE}/manga/${id}`, { headers: HEADERS })
        const html = resp.data

        // Título
        const titleM = html.match(/<h1[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)<\/h1>/) ||
                       html.match(/<h1[^>]*>([^<]+)<\/h1>/)
        const title = titleM ? clean(titleM[1]) : id

        // Portada
        const imgM = html.match(/class="[^"]*cover[^"]*"[\s\S]*?src="([^"]+)"/) ||
                     html.match(/property="og:image"\s+content="([^"]+)"/)
        const image = imgM ? (imgM[1].startsWith("http") ? imgM[1] : `${BASE}${imgM[1]}`) : ""

        // Estado (Ongoing / Completed)
        let status = "unknown"
        if (/ongoing/i.test(html)) status = "ongoing"
        else if (/completed/i.test(html)) status = "completed"

        // Descripción
        const descM = html.match(/class="[^"]*synopsis[^"]*"[^>]*>([\s\S]*?)<\//)
        const description = descM ? clean(descM[1].replace(/<[^>]+>/g, "")) : ""

        return { title, image, status, description }
    }

    // ----------------------------------------------------------
    // LISTA DE CAPÍTULOS
    // Los capítulos están en la página del manga como lista HTML
    // ----------------------------------------------------------
    async findChapters(id) {
        const resp = await $http.get(`${BASE}/manga/${id}`, { headers: HEADERS })
        const html = resp.data

        const chapters = []

        // Patron típico de sitios PHP de manga:
        // href="/read/SLUG/chapter/NUM" o href="/manga/SLUG/CHAP-NUM"
        const re = /href="([^"]*(?:chapter|chap)[^"]*)"[^>]*>[\s\S]*?(?:Chapter|Chap(?:ter)?)\s*([\d.]+)/gi
        let m
        const seen = new Set()
        while ((m = re.exec(html)) !== null) {
            const href = m[1].startsWith("http") ? m[1] : `${BASE}${m[1]}`
            const number = parseFloat(m[2])
            if (seen.has(href)) continue
            seen.add(href)

            // El ID del capítulo será la URL completa (o solo el path)
            const chapId = href.replace(BASE, "")
            chapters.push({
                id: `${id}||${chapId}`,
                title: `Chapter ${number}`,
                number,
                date: new Date(),
            })
        }

        // Ordenar descendente (último capítulo primero)
        chapters.sort((a, b) => b.number - a.number)
        return chapters
    }

    // ----------------------------------------------------------
    // PÁGINAS DE UN CAPÍTULO
    // ----------------------------------------------------------
    async findChapterPages(id) {
        const [mangaId, chapPath] = id.split("||")
        const url = chapPath.startsWith("http") ? chapPath : `${BASE}${chapPath}`

        const resp = await $http.get(url, { headers: HEADERS })
        const html = resp.data

        const pages = []

        // Las imágenes suelen estar en un array JS o como <img> tags
        // Intento 1: array JS tipo ["url1","url2",...]
        const jsArrM = html.match(/(?:pages|images|imgs)\s*=\s*(\[[^\]]+\])/)
        if (jsArrM) {
            try {
                const arr = JSON.parse(jsArrM[1].replace(/'/g, '"'))
                arr.forEach((url, idx) => {
                    const fullUrl = url.startsWith("http") ? url : `${BASE}${url}`
                    pages.push({ url: fullUrl, index: idx })
                })
                if (pages.length > 0) return pages
            } catch (e) { /* sigue */ }
        }

        // Intento 2: tags <img> dentro del lector
        const re = /class="[^"]*(?:page|reader|chapter)[^"]*"[\s\S]*?src="([^"]+\.(jpg|jpeg|png|webp|gif))"/gi
        let m
        let idx = 0
        while ((m = re.exec(html)) !== null) {
            const imgUrl = m[1].startsWith("http") ? m[1] : `${BASE}${m[1]}`
            pages.push({ url: imgUrl, index: idx++ })
        }

        // Intento 3: cualquier imagen con data-src (lazy loading)
        if (pages.length === 0) {
            const re2 = /data-src="([^"]+\.(jpg|jpeg|png|webp))"/gi
            while ((m = re2.exec(html)) !== null) {
                const imgUrl = m[1].startsWith("http") ? m[1] : `${BASE}${m[1]}`
                pages.push({ url: imgUrl, index: idx++ })
            }
        }

        return pages
    }
}

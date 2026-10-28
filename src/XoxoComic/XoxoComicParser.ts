import {
    Chapter,
    ChapterDetails,
    Tag,
    SourceManga,
    PartialSourceManga,
    TagSection
} from '@paperback/types'

import { decode as decodeHTMLEntity } from 'html-entities'
import { CheerioAPI } from 'cheerio'

const XOXO_DOMAIN = 'https://xoxocomic.com'

const clean = (text: string | undefined): string => decodeHTMLEntity((text ?? '').replace(/\s+/g, ' ').trim())

// Lazy-loaded images keep the real URL in data-original / data-src; src is a 1x1 placeholder.
const imageFrom = (attrs: { [key: string]: string | undefined } | undefined): string => {
    for (const key of ['data-original', 'data-src', 'src']) {
        const value = attrs?.[key]?.trim()
        if (!value || value.startsWith('data:')) continue
        if (value.startsWith('//')) return 'https:' + value
        if (value.startsWith('/')) return XOXO_DOMAIN + value
        return value
    }
    return ''
}

// https://xoxocomic.com/comic/<mangaId>[/<chapterId>] -> mangaId
const mangaIdFrom = (href: string | undefined): string => {
    const match = (href ?? '').match(/\/comic\/([^/?#]+)/)
    return match?.[1] ?? ''
}

export const parseMangaDetails = ($: CheerioAPI, mangaId: string): SourceManga => {
    const detail = $('#item-detail')

    const title = clean($('h1.title-detail', detail).text()).replace(/\s+Comic$/i, '')
    const image = imageFrom($('.col-image img', detail).attr())
    const author = clean($('li.author p', detail).last().text())
    const rawStatus = clean($('li.status p', detail).last().text())
    const description = clean($('.detail-content p', detail).text())

    const tags: Tag[] = []
    for (const genre of $('li.kind a', detail).toArray()) {
        const label = clean($(genre).text())
        const id = $(genre).attr('href')?.split('/').pop() ?? ''
        if (!id || !label) continue
        tags.push(App.createTag({ id, label }))
    }
    const tagSections: TagSection[] = [App.createTagSection({ id: '0', label: 'genres', tags })]

    return App.createSourceManga({
        id: mangaId,
        mangaInfo: App.createMangaInfo({
            titles: [title || mangaId],
            image,
            author,
            artist: author,
            status: /complete/i.test(rawStatus) ? 'Completed' : 'Ongoing',
            tags: tagSections,
            desc: description
        })
    })
}

// Highest ?page=N in the issue list pagination (1 when there is none).
export const getChapterPageCount = ($: CheerioAPI): number => {
    let max = 1
    for (const link of $('ul.pagination a').toArray()) {
        const page = Number($(link).attr('href')?.match(/[?&]page=(\d+)/)?.[1])
        if (!isNaN(page) && page > max) max = page
    }
    return max
}

// `pages` are the series page's issue-list pages in order; the site lists newest first.
export const parseChapters = (pages: CheerioAPI[], mangaId: string): Chapter[] => {
    const chapters: Chapter[] = []
    const seen = new Set<string>()
    let seriesTitle = ''

    for (const $ of pages) {
        if (!seriesTitle) seriesTitle = clean($('#item-detail h1.title-detail').text()).replace(/\s+Comic$/i, '')

        for (const row of $('#nt_listchapter li.row:not(.heading)').toArray()) {
            const link = $('.chapter a', row)
            const href = link.attr('href') ?? ''
            const chapterId = href.match(new RegExp(`/comic/${mangaId}/([^/?#]+)`))?.[1] ?? ''
            if (!chapterId || seen.has(chapterId)) continue
            seen.add(chapterId)

            // "Nightwing (2016) Issue #143" -> "Issue #143"
            let name = clean(link.text())
            if (seriesTitle && name.startsWith(seriesTitle)) name = name.slice(seriesTitle.length).trim()

            const issueNumber = Number(name.match(/(?:issue|chapter)\s*#?\s*(\d+(?:\.\d+)?)/i)?.[1]
                ?? chapterId.match(/^(?:issue|chapter)-(\d+(?:\.\d+)?)/i)?.[1])

            const date = new Date(clean($('div.col-xs-3', row).last().text()))

            chapters.push({
                id: chapterId,
                name: name || chapterId,
                langCode: '🇬🇧',
                chapNum: isNaN(issueNumber) ? 0 : issueNumber,
                time: isNaN(date.getTime()) ? new Date(0) : date,
                volume: 0,
                group: '',
                // Keep the site's order: the first (newest) row gets the highest index.
                sortingIndex: 0
            })
        }
    }

    if (chapters.length == 0) {
        throw new Error(`Couldn't find any issues for mangaId: ${mangaId}!`)
    }

    return chapters.map((chapter, index) => App.createChapter({ ...chapter, sortingIndex: chapters.length - index }))
}

export const parseChapterDetails = ($: CheerioAPI, mangaId: string, chapterId: string): ChapterDetails => {
    const pages: string[] = []

    for (const img of $('.page-chapter img, .reading-detail img').toArray()) {
        const image = imageFrom($(img).attr())
        if (!image || pages.includes(image)) continue
        pages.push(image)
    }

    if (pages.length == 0) {
        throw new Error(`Couldn't find any pages for ${mangaId}/${chapterId}!`)
    }

    return App.createChapterDetails({
        id: chapterId,
        mangaId,
        pages
    })
}

// The "Trending Comics" carousel at the top of the home page.
export const parseTrending = ($: CheerioAPI): PartialSourceManga[] => {
    const comics: PartialSourceManga[] = []
    const seen = new Set<string>()

    for (const item of $('.items-slide .item').toArray()) {
        const titleLink = $('.slide-caption h3 a', item)
        const id = mangaIdFrom(titleLink.attr('href'))
        const title = clean(titleLink.text())
        if (!id || !title || seen.has(id)) continue
        seen.add(id)

        comics.push(App.createPartialSourceManga({
            mangaId: id,
            title,
            image: imageFrom($('img', item).first().attr()),
            subtitle: clean($('.slide-caption > a', item).first().text())
        }))
    }
    return comics
}

// The standard comic grid used by the home page, listing pages and search results.
export const parseComicGrid = ($: CheerioAPI): PartialSourceManga[] => {
    const comics: PartialSourceManga[] = []
    const seen = new Set<string>()

    for (const item of $('.items .item').toArray()) {
        const titleLink = $('figcaption h3 a', item)
        const id = mangaIdFrom(titleLink.attr('href'))
        const title = clean(titleLink.text())
        if (!id || !title || seen.has(id)) continue
        seen.add(id)

        comics.push(App.createPartialSourceManga({
            mangaId: id,
            title,
            image: imageFrom($('.image img', item).first().attr()),
            subtitle: clean($('figcaption li.chapter a', item).first().text())
        }))
    }

    // "Latest Updates" (/comic-update) uses a list layout instead of the grid.
    for (const row of $('.list-chapter li.row:not(.heading)').toArray()) {
        const titleLink = $('h3 a', row).first()
        const id = mangaIdFrom(titleLink.attr('href'))
        const title = clean(titleLink.text())
        if (!id || !title || seen.has(id)) continue
        seen.add(id)

        let subtitle = clean($('ul.hlb-list a', row).first().text())
        if (subtitle.startsWith(title)) subtitle = subtitle.slice(title.length).trim()

        comics.push(App.createPartialSourceManga({
            mangaId: id,
            title,
            image: imageFrom($('.box_img img', row).first().attr()),
            subtitle
        }))
    }
    return comics
}

export const hasNextPage = ($: CheerioAPI): boolean => $('ul.pagination a[rel="next"]').length > 0

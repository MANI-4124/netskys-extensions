import {
    SourceManga,
    Chapter,
    ChapterDetails,
    HomeSection,
    HomeSectionType,
    SearchRequest,
    PagedResults,
    SourceInfo,
    ContentRating,
    Request,
    Response,
    SourceIntents,
    ChapterProviding,
    MangaProviding,
    SearchResultsProviding,
    HomePageSectionsProviding
} from '@paperback/types'

import * as cheerio from 'cheerio'

import {
    parseMangaDetails,
    parseChapters,
    getChapterPageCount,
    parseChapterDetails,
    parseTrending,
    parseComicGrid,
    hasNextPage
} from './XoxoComicParser'

const XOXO_DOMAIN = 'https://xoxocomic.com'

export const XoxoComicInfo: SourceInfo = {
    version: '1.0.2',
    name: 'XoxoComic',
    icon: 'icon.png',
    author: 'MANI-4124',
    authorWebsite: 'https://github.com/MANI-4124',
    description: 'Browse comics and issues on xoxocomic.com. Reading may be unavailable because the site inconsistently serves page images to third-party readers.',
    contentRating: ContentRating.MATURE,
    websiteBaseURL: XOXO_DOMAIN,
    sourceTags: [],
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED
}

// Listing pages on the site, used for the home sections and "View More".
const LISTINGS: Record<string, { title: string, path: string }> = {
    latest_comic: { title: 'Latest Updates', path: '/comic-update' },
    popular_comic: { title: 'Popular Comics', path: '/popular-comic' },
    new_comic: { title: 'New Comics', path: '/new-comic' }
}

export class XoxoComic implements SearchResultsProviding, MangaProviding, ChapterProviding, HomePageSectionsProviding {

    requestManager = App.createRequestManager({
        requestsPerSecond: 3,
        requestTimeout: 20000,
        interceptor: {
            interceptRequest: async (request: Request): Promise<Request> => {
                request.headers = {
                    ...(request.headers ?? {}),
                    ...{
                        'referer': `${XOXO_DOMAIN}/`,
                        'user-agent': await this.requestManager.getDefaultUserAgent()
                    }
                }
                return request
            },
            interceptResponse: async (response: Response): Promise<Response> => {
                return response
            }
        }
    })

    getMangaShareUrl(mangaId: string): string { return `${XOXO_DOMAIN}/comic/${mangaId}` }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const $ = await this.loadPage(`${XOXO_DOMAIN}/comic/${mangaId}`)
        return parseMangaDetails($, mangaId)
    }

    async getChapters(mangaId: string): Promise<Chapter[]> {
        // The issue list is split into pages of 50 (newest first): /comic/<id>?page=N
        const first = await this.loadPage(`${XOXO_DOMAIN}/comic/${mangaId}`)
        const pageCount = getChapterPageCount(first)

        const pages: cheerio.CheerioAPI[] = [first]
        for (let page = 2; page <= pageCount; page++) {
            pages.push(await this.loadPage(`${XOXO_DOMAIN}/comic/${mangaId}?page=${page}`))
        }

        return parseChapters(pages, mangaId)
    }

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        // "/all" is the site's "All pages" reader mode, which lists every page image.
        const $ = await this.loadPage(`${XOXO_DOMAIN}/comic/${mangaId}/${chapterId}/all`)
        return parseChapterDetails($, mangaId, chapterId)
    }

    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        const trending = App.createHomeSection({
            id: 'trending_comic', title: 'Trending Comics', containsMoreItems: false,
            type: HomeSectionType.singleRowLarge
        })
        const listingSections = Object.entries(LISTINGS).map(([id, listing]) => App.createHomeSection({
            id, title: listing.title, containsMoreItems: true,
            type: HomeSectionType.singleRowNormal
        }))

        // Show empty sections right away so the page lays out while loading.
        sectionCallback(trending)
        for (const section of listingSections) sectionCallback(section)

        const home = await this.loadPage(XOXO_DOMAIN)
        trending.items = parseTrending(home)
        sectionCallback(trending)

        for (const section of listingSections) {
            const listing = LISTINGS[section.id]
            if (!listing) continue
            const $ = await this.loadPage(`${XOXO_DOMAIN}${listing.path}`)
            section.items = parseComicGrid($)
            sectionCallback(section)
        }
    }

    async getViewMoreItems(homepageSectionId: string, metadata: any): Promise<PagedResults> {
        if (metadata?.completed) return App.createPagedResults({ results: [] })

        const listing = LISTINGS[homepageSectionId]
        if (!listing) throw new Error(`Requested to getViewMoreItems for a section ID which doesn't exist: ${homepageSectionId}`)

        const page: number = metadata?.page ?? 1
        const $ = await this.loadPage(`${XOXO_DOMAIN}${listing.path}?page=${page}`)

        return App.createPagedResults({
            results: parseComicGrid($),
            metadata: hasNextPage($) ? { page: page + 1 } : { completed: true }
        })
    }

    async getSearchResults(query: SearchRequest, metadata: any): Promise<PagedResults> {
        if (metadata?.completed) return App.createPagedResults({ results: [] })

        const page: number = metadata?.page ?? 1
        const keyword = encodeURIComponent((query.title ?? '').trim())
        const $ = await this.loadPage(`${XOXO_DOMAIN}/search-comic?keyword=${keyword}&page=${page}`)

        return App.createPagedResults({
            results: parseComicGrid($),
            metadata: hasNextPage($) ? { page: page + 1 } : { completed: true }
        })
    }

    async getCloudflareBypassRequestAsync(): Promise<Request> {
        return App.createRequest({
            url: XOXO_DOMAIN,
            method: 'GET',
            headers: {
                'referer': `${XOXO_DOMAIN}/`,
                'user-agent': await this.requestManager.getDefaultUserAgent()
            }
        })
    }

    private async loadPage(url: string): Promise<cheerio.CheerioAPI> {
        const request = App.createRequest({ url, method: 'GET' })
        const response = await this.requestManager.schedule(request, 1)
        this.checkCloudflare(response.status)
        return cheerio.load(response.data as string)
    }

    private checkCloudflare(status: number): void {
        if (status == 503 || status == 403) {
            throw new Error(`CLOUDFLARE BYPASS ERROR:\nPlease go to the homepage of <${XoxoComicInfo.name}> and press the cloud icon.`)
        }
    }
}

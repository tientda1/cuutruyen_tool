// ==UserScript==
// @name        NutAID
// @match       *://*/*
// @version     1.2.0-indev5
// @author      nutzlos
// @description Nut's All Image Downloader.
// @run-at      document-start
// @inject-into content
// @sandbox     DOM
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       GM_xmlhttpRequest
// @connect     *

// ==/UserScript==

// Mock GM_ functions for Playwright environment
window.GM_getValue = function(key, def) {
    try {
        let v = localStorage.getItem('GM_' + key);
        return v ? JSON.parse(v) : def;
    } catch(e) { return def; }
};
window.GM_setValue = function(key, val) {
    try {
        localStorage.setItem('GM_' + key, JSON.stringify(val));
    } catch(e) {}
};
window.GM_xmlhttpRequest = function(opts) {
    fetch(opts.url, {
        method: opts.method || 'GET',
        headers: opts.headers
    })
    .then(r => r.blob().then(b => ({response: b, responseHeaders: Array.from(r.headers.entries()).map(x=>x[0]+': '+x[1]).join('\\r\\n')})))
    .then(opts.onload)
    .catch(opts.onerror);
};

(function () {
    const LOGGING = "console";   //possible values: false or "", "log" or true, "console"
    let OPTIONS = {
        trackingProtection: GM_getValue('trackingProtection', true),
        arbitraryFillStyle: GM_getValue('arbitraryFillStyle', false),
        allowText: GM_getValue('allowText', false),
        mergedDownloads: GM_getValue('mergedDownloads', false),
        binbMerging: GM_getValue('binbMerging', true),
        modifyImgSrcLoading: GM_getValue('modifyImgSrcLoading', false),
        keys: {
            toContext: 'xyyxyxyyxxxy',
            toPageTop: 'asaasssassaas'
        }
    }

    let keySeed = GM_getValue('communicationKey', {
        lastUsed: -Infinity,
        value: 0
    })
    //generate new one if key has been unused for more than 2 hours
    if (new Date() - keySeed.lastUsed > 7.2e6) {
        keySeed.value = (Math.random() * 1e16) & (0xffffffff)
    }
    keySeed.lastUsed = (new Date()).valueOf()
    GM_setValue('communicationKey', keySeed)

    const generateKey = ((seed) => {
        let state = seed
        const xorshift = () => {
            state ^= state << 13
            state ^= state >> 17
            state ^= state << 5
            return state
        }
        let cipher = 'abcdefghijklmnopQRSTUVWxyzABCDEFGHIJKLMNOPqrstuvwXYZ'
        return (length, maxLength) => {
            if (maxLength && maxLength != length) {
                length = Math.abs(xorshift() % (maxLength - length)) + length
            }
            let key = ''
            for (let i = length; i > 0; --i) {
                key += cipher.charAt(Math.abs(xorshift() % cipher.length))
            }
            return key
        }
    })(keySeed.value)

    OPTIONS.keys.toContext = generateKey(30)
    OPTIONS.keys.toPageTop = generateKey(30)


    let pageScript = function (OPTIONS) {
        let targetWindow = this
        //cross origin iframes will not be able to dispatch events to the top level window.
        //even the content script cannot work around that without being detectable.
        //therefore, we need to add nested menus
        let windowtop = targetWindow //since this is run in an iframe for added isolation, the target window will be the parent
        try {
            while (windowtop != window.top) {
                if ('dispatchEvent' in windowtop.parent) {
                    windowtop = windowtop.parent
                } else {
                    break
                }
            }
        } catch (e) { }

        const logger = (function () {
            return (title, that, args) => {
                if (title.includes('toString')) return;
                let e = new CustomEvent(OPTIONS.keys.toPageTop, {
                    detail: {
                        action: 'log',
                        title: title,
                        that: that,
                        args: args,
                        context: targetWindow
                    }
                })
                windowtop.dispatchEvent(e)
            }
        })()

        if (targetWindow == windowtop) {
            function IndexTracker() {
                let values = []
                function getID(value) {
                    if (!value) return null;
                    let i = values.indexOf(value)
                    if (i < 0) {
                        values.push(value)
                        i = values.indexOf(value)
                    }
                    return i
                }
                return getID
            }
            const capturedFramesIndex = new IndexTracker()
            capturedFramesIndex(this)
            targetWindow.addEventListener(OPTIONS.keys.toPageTop, (e) => {
                e.detail.context = capturedFramesIndex(e.detail.context)
                let ev = new CustomEvent(OPTIONS.keys.toContext, {
                    detail: e.detail
                })
                dispatchEvent(ev)
            })
        }

        const canvasToBlob = HTMLCanvasElement.prototype.toBlob
        const ctxDrawImage = CanvasRenderingContext2D.prototype.drawImage
        const canvasToDataURL = HTMLCanvasElement.prototype.toDataURL
        const createUrlFromBlob = URL.createObjectURL
        const imgSetSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src').set

        let globalImageCounter = 0
        function captureNewImage(image = null, source = null, risky, scrambleParams) {
            //image = element the image was caught on, if applicable
            //source = the source object/element that was captured
            if (scrambleParams === undefined) {
                scrambleParams = dirtyFlag('get:params', image)
            }
            if (risky === undefined) {
                risky = dirtyFlag('get:risky', image) | dirtyFlag('get:risky', source)
            }
            let e = new CustomEvent(OPTIONS.keys.toPageTop, {
                detail: {
                    action: 'captureImage',
                    image: image,
                    source: source,
                    risky: risky,
                    scrambleParams: scrambleParams,
                    context: targetWindow
                }
            })
            windowtop.dispatchEvent(e)
            dirtyFlag('clear', image)
        }

        function extensionFromMimeType(mime) {
            let extension
            switch (mime) {
                case 'image/png':
                    extension = '.png'
                    break;
                case 'image/webp':
                    extension = '.webp'
                    break;
                case 'image/gif':
                    extension = '.gif'
                    break;
                case 'image/avif':
                    extension = '.avif'
                    break;
                case 'image/jxl':
                    extension = '.jxl'
                    break;
                case 'image/svg+xml':
                    extension = '.svg'
                    break;
                default:
                    extension = '.jpeg'
                    break
            }
            return extension
        }
        function GM_xmlhttpRequest_asyncWrapper(urlToFetch) {
            return new Promise((resolve, reject) => {
                let url = new URL(urlToFetch, location.href)
                let sameOrigin = urlToFetch.startsWith(location.origin)
                window.GM_xmlhttpRequest({
                    url: url.href,
                    responseType: 'blob',
                    anonymous: false,
                    headers: {
                        'Referer': location.origin + '/',
                        'Sec-Fetch-Dest': 'image',
                        'Sec-Fetch-Mode': 'no-cors',
                        'Sec-Fetch-Site': sameOrigin ? 'same-origin' : 'cross-site',
                        'Pragma': 'no-cache',
                        'Cache-Control': 'no-cache'
                    },
                    onload: resolve,
                    onerror: reject
                })
            })
        }
        async function fetchImg(url) {
            if (url.startsWith('http')) {
                let r = await GM_xmlhttpRequest_asyncWrapper(url)
                let mime = r.responseHeaders.match(/content-type: (.*)/i)
                return {
                    data: await r.response,
                    contentType: mime && mime[1]
                }
            } else {
                let r = await fetch(url, { cache: 'force-cache' })
                return {
                    data: await r.blob(),
                    contentType: r.headers.get('content-type')
                }
            }
        }

        async function dlAllImgs() {
            let promises = []
            let filenameCounter = 0
            let fileCompletedCounter = 0
            dledImgsCounterElement.innerText = '(0 imgs)'
            async function getImg(x, i) {
                const url = x.getAttribute('data-original') || x.getAttribute('data-src') || x.getAttribute('content')
                let img
                try {
                    img = await fetchImg(url)
                } catch (e) {
                    img = await fetchImg(x.src)
                }
                let extension = extensionFromMimeType(img.contentType)
                let filename = String(i).padStart(4, '0')
                dledImgsCounterElement.innerText = `(${++fileCompletedCounter} imgs)`
                return {
                    name: filename + extension,
                    data: await img.data.arrayBuffer()
                }
            }
            for (let x of document.getElementsByTagName('img')) {
                promises.push(getImg(x, ++filenameCounter))
            }
            Promise.allSettled(promises).then((p) => {
                let files = []
                p.map(x => (x.status == 'fulfilled') && files.push(x.value))
                let zipData = SimpleZip.GenerateZipFrom(files)
                let blob = new Blob([zipData], { type: "octet/stream" })
                var url = createUrlFromBlob(blob);
                createDownload(url, (+new Date()) + '.zip')
                dledImgsCounterElement.innerText = ''
            })
        }

        let dirtyFlagPerCanvas = new Map()
        function dirtyFlag(op, canvas, img_source = null, drawImageParams) {
            if (op.startsWith('set')) {
                let o = {
                    dirty: true,
                    risky: false,
                    timer: null,
                    lastSource: null,
                    variousSources: false,
                    drawImageSequence: []
                }
                if (dirtyFlagPerCanvas.has(canvas)) {
                    o = dirtyFlagPerCanvas.get(canvas)
                    o.dirty = true
                }
                if (img_source) {
                    o.lastSource = img_source
                }
                if (op.includes('+timer')) {
                    if (o.timer) {
                        clearTimeout(o.timer)
                    }
                    o.timer = setTimeout((y, z) => captureNewImage(y, z), 500, canvas, img_source)
                }
                if (op.includes('+risky')) {
                    o.risky = true
                }
                if (op.includes('+params')) {
                    if (drawImageParams) o.drawImageSequence.push(drawImageParams)
                }
                if (op.includes('+varisrc')) {
                    o.variousSources = true
                }
                dirtyFlagPerCanvas.set(canvas, o)
            }
            if (op == 'clear') {
                if (dirtyFlagPerCanvas.has(canvas)) {
                    let o = dirtyFlagPerCanvas.get(canvas)
                    if (o.timer) {
                        clearTimeout(o.timer)
                    }
                    dirtyFlagPerCanvas.delete(canvas)
                }
            }
            if (op.startsWith('get')) {
                if (dirtyFlagPerCanvas.has(canvas)) {
                    let o = dirtyFlagPerCanvas.get(canvas)
                    if (op == 'get:risky') {
                        return o.risky
                    }
                    if (op == 'get:source') {
                        return o.lastSource
                    }
                    if (op == 'get:params') {
                        return o.drawImageSequence
                    }
                    if (op == 'get:varisrc') {
                        return o.variousSources
                    }
                    return o.dirty
                } else {
                    return false
                }
            }
        }



        const urlToBlobMapping = {}



        function copyToCanvas(image, scramble) {
            if (!(scramble?.compare?.size > 1))
                scramble = {};
            let c = document.createElement('canvas')
            c.width = scramble.w || image.naturalWidth || image.width
            c.height = scramble.h || image.naturalHeight || image.height
            c.style.maxWidth = previewImageSize + 'px'
            c.style.maxHeight = previewImageSize + 'px'
            let ctx = c.getContext('2d')
            if (scramble.compare && scramble.compare.size) {
                ctxDrawImage.call(ctx, image, scramble.x, scramble.y, c.width, c.height, 0, 0, c.width, c.height)
            } else {
                ctxDrawImage.call(ctx, image, 0, 0)
            }
            return c
        }


        function setupIntercept(window) {
            const funcsToConceil = new Map()
            const originalFuncs = new Map()
            const orig = (f) => originalFuncs.get(f)

            function createInterceptorFunction(originalFunction, newFunction, baseObj) {
                let originalProps = Object.getOwnPropertyDescriptors(originalFunction)
                let loggingTag = baseObj[Symbol.toStringTag] + '.'
                loggingTag += originalProps.name.value.includes(' ') ? `[${originalProps.name.value}]` : originalProps.name.value
                let interceptor = {
                    fuckShit() {
                        logger(loggingTag, this, arguments)
                        return newFunction.apply(this, arguments)
                    }
                }.fuckShit
                Object.defineProperties(interceptor, originalProps)
                funcsToConceil.set(interceptor, originalFunction)
                originalFuncs.set(newFunction, originalFunction)
                return interceptor
            }

            function interceptFunction(obj, prop, fun) {
                const old = obj[prop]
                let ifunc = createInterceptorFunction(old, fun, obj)
                obj[prop] = ifunc
            }
            function interceptProperty(obj, prop, getOrSet, fun) {
                const old = Object.getOwnPropertyDescriptor(obj, prop)
                if (typeof old[getOrSet] != 'function') {
                    console.warn('Risky interceptor for ', fun)
                    debugger
                }
                let ifunc = createInterceptorFunction(old[getOrSet], fun, obj)
                let x = {}
                x[getOrSet] = ifunc
                Object.defineProperty(obj, prop, x)
            }

            interceptFunction(window.Function.prototype, 'toString', function toString() {
                return orig(toString).apply(funcsToConceil.get(this) || this, arguments)
            })

            //image interception
            interceptFunction(window.CanvasRenderingContext2D.prototype, 'drawImage', function drawImage(...args) {
                //do what needs to be done
                let img_source = args[0], img

                let oldsrc = dirtyFlag('get:source', this.canvas)
                if (oldsrc && oldsrc != img_source) {
                    if (!dirtyFlag('get:varisrc', this.canvas)) {
                        let prevParams = dirtyFlag('get:params', this.canvas)
                        if (prevParams.length == 1 && (prevParams[0][2] < this.canvas.width || prevParams[0][3] < this.canvas.height)) {
                            dirtyFlag('set+varisrc', this.canvas)
                        } else {
                            //source changes are sus, rip to be on the safe side
                            captureNewImage(this.canvas, oldsrc)
                            dirtyFlag('set+risky', this.canvas)
                        }
                    }
                    if (dirtyFlag('get:varisrc', this.canvas)) {
                        captureNewImage("delete", oldsrc)
                    }
                }

                // if (img_source.toString() == "[object HTMLImageElement]" && img_source.naturalHeight == 0) debugger
                if ((args.length == 3 || (
                    // args.length == 5 &&
                    args[1] == 0 &&
                    args[2] == 0 &&
                    args[3] == img_source.width &&
                    args[4] == img_source.height
                )) &&
                    img_source.width >= this.canvas.width &&
                    img_source.height >= this.canvas.height
                ) {
                    //no cropping of the source image, or it covers the whole canvas
                    if (dirtyFlag('get', this.canvas)) {
                        captureNewImage(this.canvas, dirtyFlag('get:source', this.canvas))
                    }
                    //dirtyFlag('clear', this.canvas)   //done by captureNewImage, in theory that should be enough
                    let source = img_source

                    //set scrambling param just in case only part of the image is scrambled
                    //make the params compatible with the full length drawImage arguments
                    let fullLengthArgs = [
                        0, 0,                               //source origin
                        img_source.width, img_source.height,//source dimensions
                        0, 0,                               //target origin
                        img_source.width, img_source.height //target dimensions
                    ]
                    dirtyFlag('set+params', this.canvas, img_source, fullLengthArgs)

                    captureNewImage(this.canvas, img_source)
                } else {
                    let params = []
                    if (args.length < 9) {
                        params.push([
                            0, 0,                               //source origin
                            img_source.width, img_source.height,//source dimensions
                        ])
                    }
                    params.push(args.slice(1))
                    if (args.length < 5) {
                        params.push([
                            img_source.width, img_source.height,//destination dimensions
                        ])
                    }
                    params = params.flat()
                    //need to canvas rip because the image is likely to be scrambled
                    dirtyFlag('set+timer+params', this.canvas, img_source, params)
                }
                //call the proper function
                return ctxDrawImage.apply(this, args)
            })

            function ignoreSource(source) {
                let e = new CustomEvent(OPTIONS.keys.toPageTop, {
                    detail: {
                        action: 'ignoreSource',
                        source: source,
                        context: window
                    }
                })
                windowtop.dispatchEvent(e)
            }
            interceptFunction(window.HTMLCanvasElement.prototype, 'toBlob', function toBlob() {
                if (dirtyFlag('get', this)) {
                    let src = dirtyFlag('get:source', this)
                    //If no image made its way to the canvas, then there's no need to capture it
                    if (src) captureNewImage(this, src)
                }
                return canvasToBlob.call(this, (b) => {
                    ignoreSource(b)
                    arguments[0](b)
                })
            })
            interceptFunction(window.HTMLCanvasElement.prototype, 'toDataURL', function toDataURL() {
                if (dirtyFlag('get', this)) {
                    let src = dirtyFlag('get:source', this)
                    //If no image made its way to the canvas, then there's no need to capture it
                    if (src) captureNewImage(this, src)
                }
                let uri = canvasToDataURL.apply(this, arguments)
                ignoreSource(uri)
                return uri
            })
            interceptFunction(window.CanvasRenderingContext2D.prototype, 'putImageData', function putImageData() {
                dirtyFlag('set+risky+timer', this.canvas)
                const ret = orig(putImageData).apply(this, arguments)
                if (arguments[0].width == this.canvas.width && arguments[0].height == this.canvas.height) {
                    captureNewImage(this.canvas, arguments[0])
                }
                return ret
            })
            interceptFunction(window.CanvasRenderingContext2D.prototype, 'createPattern', function createPattern() {
                //capture the image that's passed in but don't link it to this canvas as technically
                //nothing happened just yet and we don't want to reset the dirty flag just yet
                captureNewImage('canvaspattern', arguments[0])
                let pattern = orig(createPattern).apply(this, arguments)
                ignoreSource(pattern)
                return pattern
            })

            interceptFunction(window.URL, 'createObjectURL', function createObjectURL() {
                let url = createUrlFromBlob(...arguments)
                let blob = arguments[0]
                urlToBlobMapping[url] = blob
                let e = new CustomEvent(OPTIONS.keys.toPageTop, {
                    detail: {
                        action: 'urlToBlob',
                        url: url,
                        blob: blob,
                        context: window
                    }
                })
                windowtop.dispatchEvent(e)
                if (blob instanceof Blob && blob.type.startsWith('image')) {
                    captureNewImage('createObjectURL', blob)
                } else {
                    let i = new Image()
                    i.onload = () => captureNewImage('createObjectURL', blob)
                    imgSetSrc.call(i, url)
                }
                return url
            })
            
            interceptProperty(window.HTMLImageElement.prototype, 'src', 'set', function setSrc() {
                const url = arguments[0]
                if (url && url.startsWith('blob:') || url.startsWith('data:')) {
                    captureNewImage(this, url)
                    orig(setSrc).apply(this, arguments)
                } else if (OPTIONS.modifyImgSrcLoading && !this.crossOrigin) {
                    GM_xmlhttpRequest_asyncWrapper(url).then((resp) => {
                        captureNewImage(this, resp.response)
                        let u = URL.createObjectURL(resp.response)
                        orig(setSrc).call(this, u)
                    }).catch((e) => {
                        orig(setSrc).apply(this, arguments)
                    })
                } else {
                    captureNewImage(this, url)
                    orig(setSrc).apply(this, arguments)
                }
            })


            //block APIs useful for fingerprinting / tracking
            interceptFunction(window.CanvasRenderingContext2D.prototype, 'clearRect', function clearRect() {
                if (arguments[2] != this.canvas.width && arguments[3] != this.canvas.height) {
                    if (!OPTIONS.trackingProtection) {
                        dirtyFlag('set+risky', this.canvas)
                        return orig(clearRect).apply(this, arguments)
                    } else {
                        return
                    }
                }
                if (dirtyFlag('get', this.canvas)) {
                    let src = dirtyFlag('get:source', this.canvas)
                    //If no image made its way to the canvas, then there's no need to capture it
                    if (src) captureNewImage(this.canvas, src)
                }
                return orig(clearRect).apply(this, arguments)
            })
            //setting canvas width/height can also clear the canvas
            interceptProperty(window.HTMLCanvasElement.prototype, 'width', 'set', function setWidth() {
                if (dirtyFlag('get', this)) {
                    let src = dirtyFlag('get:source', this)
                    //If no image made its way to the canvas, then there's no need to capture it
                    if (src) captureNewImage(this, src)
                }
                return orig(setWidth).apply(this, arguments)
            })
            interceptProperty(window.HTMLCanvasElement.prototype, 'height', 'set', function setHeight() {
                if (dirtyFlag('get', this)) {
                    let src = dirtyFlag('get:source', this)
                    //If no image made its way to the canvas, then there's no need to capture it
                    if (src) captureNewImage(this, src)
                }
                return orig(setHeight).apply(this, arguments)
            })
            interceptFunction(window.CanvasRenderingContext2D.prototype, 'fillRect', function fillRect() {
                if (arguments[2] != this.canvas.width && arguments[3] != this.canvas.height) {
                    if (!OPTIONS.trackingProtection) {
                        dirtyFlag('set+risky', this.canvas)
                        return orig(fillRect).apply(this, arguments)
                    } else {
                        return
                    }
                }
                if (dirtyFlag('get', this.canvas)) {
                    let src = dirtyFlag('get:source', this.canvas)
                    //If no image made its way to the canvas, then there's no need to capture it
                    if (src) captureNewImage(this.canvas, src)
                }
                if (OPTIONS.arbitraryFillStyle)
                    dirtyFlag('set+risky', this.canvas);
                return orig(fillRect).apply(this, arguments)
            })
            interceptFunction(window.CanvasRenderingContext2D.prototype, 'strokeRect', function strokeRect() {
                if (!OPTIONS.trackingProtection) {
                    dirtyFlag('set+risky', this.canvas)
                    return orig(strokeRect).apply(this, arguments)
                } else {
                    return
                }
            })
            interceptFunction(window.CanvasRenderingContext2D.prototype, 'fill', function fill() {
                if (!OPTIONS.trackingProtection) {
                    dirtyFlag('set+risky', this.canvas)
                    return orig(fill).apply(this, arguments)
                } else {
                    return
                }
            })
            interceptFunction(window.CanvasRenderingContext2D.prototype, 'stroke', function stroke() {
                if (!OPTIONS.trackingProtection) {
                    dirtyFlag('set+risky', this.canvas)
                    return orig(stroke).apply(this, arguments)
                } else {
                    return
                }
            })
            interceptProperty(window.CanvasRenderingContext2D.prototype, 'globalAlpha', 'set', function setAlpha() {
                if (OPTIONS.trackingProtection) {
                    return orig(setAlpha).call(this, Math.round(arguments[0]))
                } else {
                    return orig(setAlpha).call(this, arguments[0])
                }
            })
            interceptProperty(window.CanvasRenderingContext2D.prototype, 'fillStyle', 'set', function setStyle() {
                if (OPTIONS.trackingProtection && !OPTIONS.arbitraryFillStyle) {
                    return orig(setStyle).call(this, '#f60')
                } else {
                    return orig(setStyle).apply(this, arguments)
                }
            })
            interceptFunction(window.CanvasRenderingContext2D.prototype, 'fillText', function fillText() {
                if (OPTIONS.trackingProtection && !OPTIONS.allowText) {
                    return
                } else {
                    dirtyFlag('set+risky', this.canvas)
                    return orig(fillText).apply(this, arguments)
                }
            })
            interceptFunction(window.CanvasRenderingContext2D.prototype, 'strokeText', function strokeText() {
                if (OPTIONS.trackingProtection && !OPTIONS.allowText) {
                    return
                } else {
                    dirtyFlag('set+risky', this.canvas)
                    return orig(strokeText).apply(this, arguments)
                }
            })

        }
        setupIntercept(targetWindow)

        console.log('cr page script loaded')
    }
    //insert page script into page
    let injectionScript = document.createElement('script')
    let injectionCode = `
        (${pageScript.toString()})(${JSON.stringify(OPTIONS)});
        document.currentScript.remove()
    `;
    let injectionBlob = new Blob([injectionCode], { type: 'application/javascript' });
    let injectionUrl = URL.createObjectURL(injectionBlob);
    injectionScript.setAttribute('src', injectionUrl);
    if (document.documentElement) {
        document.documentElement.appendChild(injectionScript);
    } else {
        document.addEventListener('DOMContentLoaded', () => document.documentElement.appendChild(injectionScript));
    }


    let windowtop = window
    try {
        while (windowtop != window.top) {
            if ('dispatchEvent' in windowtop.parent) {
                windowtop = windowtop.parent
            } else {
                break
            }
        }
    } catch (e) { }

    if (window == windowtop) {

        function IndexTracker() {
            let values = []
            function getID(value) {
                if (!value) return null
                let i = values.indexOf(value)
                if (i < 0) {
                    values.push(value)
                    i = values.indexOf(value)
                }
                return i
            }
            return getID
        }

        let overlay = document.createElement('tbody')
        overlay.id = "nutaid-overlay";
        document.addEventListener("DOMContentLoaded", (event) => {
            overlay = document.createElement('tbody')
            overlay.id = "nutaid-overlay";
            const div = document.createElement('div')
            div.id = "nutaid-container-div";
            const shadow = div.attachShadow({ mode: 'closed' })
            shadow.innerHTML = `<table id="image-table"></table>`
            shadow.querySelector('#image-table').appendChild(overlay)
            document.documentElement.appendChild(div)
        });

        const previewImageSize = 50

        const capturedImages = new Map()
        const ignoredSources = []
        let globalImageCounter = 0
        const captureNewImage = (function () {
            function copyImage(image) {
                if (typeof image == 'string') {
                    return copyToImg(image)
                }
                switch (image.toString()) {
                    case "[object HTMLImageElement]":
                        return copyToImg(image.src)
                        break
                    case "[object Blob]":
                        return copyToImg(createUrlFromBlob(image))
                        break
                    case "[object HTMLCanvasElement]":
                    default:
                        return copyToCanvas(image)
                }
            }
            function copyToImg(url) {
                let img = new Image()
                img.style.maxWidth = previewImageSize + 'px'
                img.style.maxHeight = previewImageSize + 'px'
                imgSetSrc.call(img, url)
                return img
            }
            function copyToCanvas(image, scramble) {
                if (!(scramble?.compare?.size > 1))
                    scramble = {};
                let c = document.createElement('canvas')
                c.width = scramble.w || image.naturalWidth || image.width
                c.height = scramble.h || image.naturalHeight || image.height
                c.style.maxWidth = previewImageSize + 'px'
                c.style.maxHeight = previewImageSize + 'px'
                let ctx = c.getContext('2d')
                if (scramble.compare && scramble.compare.size) {
                    ctxDrawImage.call(ctx, image, scramble.x, scramble.y, c.width, c.height, 0, 0, c.width, c.height)
                } else {
                    ctxDrawImage.call(ctx, image, 0, 0)
                }
                return c
            }
            function processScrramblingParams(params, thingToSave) {
                if (!params) params = [];
                const tTS_w = thingToSave.naturalWidth || thingToSave.width
                const tTS_h = thingToSave.naturalHeight || thingToSave.height
                let bounds = [Infinity, Infinity, -Infinity, -Infinity]
                for (let x of params) {
                    bounds[0] = Math.min(bounds[0], x[4])
                    bounds[1] = Math.min(bounds[1], x[5])
                    bounds[2] = Math.max(bounds[2], x[4] + x[6])
                    bounds[3] = Math.max(bounds[3], x[5] + x[7])
                }
                bounds[0] = Math.max(bounds[0], 0)
                bounds[1] = Math.max(bounds[1], 0)
                bounds[2] = Math.min(bounds[2], tTS_w)
                bounds[3] = Math.min(bounds[3], tTS_h)
                return {
                    w: bounds[2] - bounds[0],
                    h: bounds[3] - bounds[1],
                    x: bounds[0],
                    y: bounds[1],
                    compare: new Set((params || []).map(x => x.slice(0, 4).join()))
                }
            }
            function mergeImages(...images) {
                let yOffset = 0
                if (OPTIONS.binbMerging) {
                    yOffset = -4
                }
                let c = document.createElement('canvas')
                c.width = Math.max(...images.map(x => x.naturalWidth || x.width))
                c.height = images.reduce((a, x) => a + (x.naturalHeight || x.height), 0) + (images.length - 1) * yOffset
                c.style.maxWidth = previewImageSize + 'px'
                c.style.maxHeight = previewImageSize + 'px'
                let ctx = c.getContext('2d')
                let y = 0
                for (let i of images) {
                    let x = Math.floor((c.width - (i.naturalWidth || i.width)) * 0.5)
                    ctxDrawImage.call(ctx, i, x, y)
                    y += (i.naturalHeight || i.height) + yOffset
                }
                return c
            }
            function addPageToPile(obj) {
                let {
                    image,
                    source,
                    risky,
                    scrambleParams,
                    context
                } = obj

                let isImageData = false, isScrambled = Boolean(scrambleParams && scrambleParams.length > 1), isFiltered = false
                globalImageCounter++
                if (!source && image.toString() == "[object HTMLImageElement]") {
                    source = image.src
                }
                if (source.toString() == "[object HTMLImageElement]") {
                    source = source.src
                }
                if (source.toString() == "[object HTMLCanvasElement]") {
                    risky |= dirtyFlag('get:risky', source)
                }
                if (image.toString() == "[object HTMLCanvasElement]") {
                    if (image.filter && image.filter != 'none') {
                        isFiltered = true
                    }
                }
                if (typeof source == 'string' && source.startsWith('blob:')) {
                    source = urlToBlobMapping[source]
                }
                if (source.toString() == "[object ImageData]") {
                    source = 'imagedata-' + globalImageCounter
                    isImageData = true
                }
                if (["[object OffscreenCanvas]", "[object ImageBitmap]"].includes(source.toString())) {
                    risky = true
                }
                if (ignoredSources.includes(source)) return false;

                if (image == 'delete') {
                    return capturedImages.delete(source)
                }

                const thingToSave = (isScrambled || isImageData || isFiltered) ? image : source
                let scramble = processScrramblingParams(scrambleParams, thingToSave)

                let existing = capturedImages.get(source)
                if (!existing) {
                    let obj = {
                        isScrambled: isScrambled,
                        individual: [{
                            savedImage: null,
                            scrambleParams: scramble.compare,
                            caughtOn: [image],
                            isRisky: !!risky
                        }],
                        combined: {}
                    }
                    let i = obj.individual[0]
                    if (isScrambled) {
                        let c = copyToCanvas(thingToSave, scramble)
                        i.savedImage = c
                    } else {
                        i.savedImage = copyImage(thingToSave)
                    }
                    capturedImages.set(source, obj)
                    obj.combined = i
                    return true
                } else {
                    if (isScrambled) {

                        let exIdx
                        if (
                            existing.isScrambled &&
                            (exIdx = existing.individual.findIndex(x => x.scrambleParams.isSubsetOf(scramble.compare))) >= 0
                        ) {
                            let exI = existing.individual[exIdx].savedImage
                            if (exI.width >= scramble.w && exI.height >= scramble.h) {
                                return false
                            } else {
                                existing.individual.splice(exIdx, 1)
                            }
                        }

                        let c = copyToCanvas(thingToSave, scramble)

                        if (existing.isScrambled) {
                            if (OPTIONS.mergedDownloads) {
                                let merged = mergeImages(existing.combined.savedImage, c)
                                let combi = {
                                    savedImage: merged,
                                    scrambleParams: '',
                                    caughtOn: existing.combined.caughtOn.slice(),
                                    isRisky: !!risky || existing.combined.risky
                                }
                                if (!combi.caughtOn.includes(image)) combi.caughtOn.push(image);
                                existing.combined = combi
                            }
                            existing.individual.push({
                                savedImage: c,
                                scrambleParams: scramble.compare,
                                caughtOn: [image],
                                isRisky: !!risky
                            })
                        } else {
                            let obj = existing.combined 
                            obj.savedImage = copyImage(c)
                            obj.scrambleParams = scramble.compare.union(obj.scrambleParams)
                            if (!obj.caughtOn.includes(image)) obj.caughtOn.push(image);
                            obj.isRisky = !!risky || obj.isRisky
                            existing.isScrambled = true
                        }
                        return true
                    } else {
                        if (!existing.combined.caughtOn.includes(image))
                            existing.combined.caughtOn.push(image);
                        if (scramble.compare.size == 1)
                            existing.combined.scrambleParams = scramble.compare.union(existing.combined.scrambleParams);
                        return true
                    }
                }
            }
            return function (obj) {
                addPageToPile(obj) && updateOverlay()
            }
        })()

        function updateOverlay() {
            let sourcedFrom = { e: [], i: [], u: [], c: [], d: [], p: [], b: [] }
            for (let x of capturedImages.entries()) {
                if (typeof x[0] == 'string') {
                    if (x[0].startsWith('imagedata')) { sourcedFrom.d.push(x) } 
                    else { if (x[1].isScrambled) { sourcedFrom.e.push(x) } else { sourcedFrom.i.push(x) } }
                } else {
                    if (typeof x[1].combined.caughtOn[0] == 'string') {
                        if (x[1].combined.caughtOn[0] == 'canvaspattern') sourcedFrom.p.push(x);
                        else sourcedFrom.b.push(x)
                    } else {
                        if (x[1].combined.caughtOn[0] instanceof HTMLCanvasElement) { sourcedFrom.c.push(x) } 
                        else { sourcedFrom.u.push(x) }
                    }
                }
            }
            overlay.innerHTML = ''
            for (let cat in sourcedFrom) {
                for (let x of sourcedFrom[cat]) {
                    let y = x[1].individual
                    for (let i = 0; i < y.length; i++) {
                        let z = y[i].savedImage
                        overlay.insertAdjacentHTML('beforeend', `<tr><td class="nutaid-captured-img"></td></tr>`)
                        if (z) overlay.lastChild.children[0].appendChild(z)
                    }
                }
            }
        }

        const urlToBlobMapping = {}

        window.addEventListener(OPTIONS.keys.toContext, (e) => {
            switch (e.detail.action) {
                case 'captureImage':
                    captureNewImage(e.detail)
                    break
                case 'urlToBlob':
                    urlToBlobMapping[e.detail.url] = e.detail.blob
                    break
                case 'ignoreSource':
                    ignoredSources.push(e.detail.source)
                    break
            }
        })

        // Auto-scroll logic exposed for Playwright
        window.NutAID_AutoChapter = {
            scroll: function() {
                return new Promise((resolve) => {
                    let lastScrollTop = -1
                    let lastScrollHeight = -1
                    let samePositionCount = 0
                    let scrollAttempts = 0
                    const maxAttempts = 300 

                    const getScrollInfo = () => {
                        return {
                            scrollTop: Math.max(document.documentElement.scrollTop, document.body.scrollTop),
                            scrollHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
                            clientHeight: window.innerHeight
                        }
                    }

                    const isAtBottom = (info) => {
                        return info.scrollTop + info.clientHeight >= info.scrollHeight - 5
                    }

                    const scrollStep = () => {
                        const info = getScrollInfo()
                        scrollAttempts++

                        if (isAtBottom(info)) {
                            if (info.scrollHeight === lastScrollHeight) {
                                samePositionCount++
                            } else {
                                samePositionCount = 0
                                lastScrollHeight = info.scrollHeight
                            }
                        } else {
                            samePositionCount = 0
                        }

                        lastScrollTop = info.scrollTop
                        lastScrollHeight = info.scrollHeight

                        if ((isAtBottom(info) && samePositionCount >= 5) || scrollAttempts >= maxAttempts) {
                            window.scrollTo(0, info.scrollHeight)
                            setTimeout(() => {
                                const finalInfo = getScrollInfo()
                                if (finalInfo.scrollHeight > info.scrollHeight) {
                                    lastScrollHeight = -1
                                    samePositionCount = 0
                                    scrollAttempts = Math.max(0, scrollAttempts - 50) 
                                    setTimeout(scrollStep, 150)
                                } else {
                                    window.scrollTo(0, finalInfo.scrollHeight)
                                    setTimeout(resolve, 1500)
                                }
                            }, 500)
                            return
                        }

                        window.scrollBy(0, 400)
                        setTimeout(() => {
                            const newInfo = getScrollInfo()
                            if (newInfo.scrollTop === info.scrollTop && !isAtBottom(info)) {
                                window.scrollTo(0, info.scrollTop + 400)
                            }
                            setTimeout(scrollStep, 150)
                        }, 10)
                    }
                    window.scrollTo(0, 0)
                    setTimeout(scrollStep, 100)
                });
            },
            getImages: function() {
                const tds = overlay.querySelectorAll('.nutaid-captured-img canvas, .nutaid-captured-img img');
                return Array.from(tds).map(el => {
                    if (el.tagName === 'CANVAS') {
                        return el.toDataURL('image/jpeg', 0.9);
                    } else if (el.tagName === 'IMG') {
                        try {
                            let c = document.createElement('canvas');
                            c.width = el.naturalWidth || el.width;
                            c.height = el.naturalHeight || el.height;
                            let ctx = c.getContext('2d');
                            ctx.drawImage(el, 0, 0);
                            return c.toDataURL('image/jpeg', 0.9);
                        } catch (e) {
                            return el.src;
                        }
                    }
                    return null;
                }).filter(Boolean);
            }
        }
    }
})();

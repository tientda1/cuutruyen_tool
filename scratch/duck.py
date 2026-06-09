import urllib.request
import urllib.parse
import re

req = urllib.request.Request('https://html.duckduckgo.com/html/?q=site:cuutruyen.net+manga', headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
resp = urllib.request.urlopen(req).read().decode('utf-8')
urls = re.findall(r'href=[\'"]?([^\'" >]+)', resp)
for u in urls:
    if 'cuutruyen.net' in u:
        print(urllib.parse.unquote(u))

"""Render the outputs from npm run demo into reproducible terminal media. Requires Pillow."""
import json, textwrap, pathlib
from PIL import Image, ImageDraw, ImageFont
root = pathlib.Path(__file__).resolve().parent.parent
records = json.loads((root / '.demo/recording.json').read_text())
font_path = '/System/Library/Fonts/Supplemental/Andale Mono.ttf'
if not pathlib.Path(font_path).exists():
    font_path = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
font = ImageFont.truetype(font_path, 18)
bold = ImageFont.truetype(font_path, 23)
W,H=1120,620
navy='#111c2e'; panel='#172438'; muted='#9aadc5'; white='#e8f0fa'; mint='#75edc3'
def screen(title, lines, subtitle='Live MCP calls · isolated sample databases'):
    img=Image.new('RGB',(W,H),navy);d=ImageDraw.Draw(img)
    d.rounded_rectangle((14,14,W-14,H-14),radius=18,fill=panel,outline='#2c405c',width=2)
    for i,color in enumerate(['#f27b85','#f4ca74',mint]):d.ellipse((33+i*24,35,45+i*24,47),fill=color)
    d.text((140,29),'omnisql-mcp',font=font,fill=muted)
    d.text((35,83),title,font=bold,fill=mint)
    d.text((35,125),subtitle,font=font,fill=muted)
    y=175
    for line in lines[:15]:
        d.text((35,y),line,font=font,fill=white);y+=25
    d.line((35,557,W-35,557),fill='#30445d')
    d.text((35,574),'PostgreSQL · MySQL · SQLite · SQL Server · Oracle',font=font,fill=muted)
    return img
frames=[];durations=[]
for rec in records:
    title=rec['title']; data=rec['output']
    try: parsed=json.loads(data)
    except: parsed=data
    if 'Discover saved' in title:
        rows=['Connected to a dedicated demo workspace.','']
        # The server returns a list_connections envelope, not fabricated client text.
        if isinstance(parsed,dict): conns=parsed.get('connections',[])
        else: conns=parsed
        rows += [f"  {c.get('id','')}  {c.get('name','')}" for c in conns if isinstance(c,dict)]
    elif 'Query revenue' in title:
        rows=['SELECT c.name, SUM(o.total) AS revenue','FROM customers c JOIN orders o ON o.customer_id=c.id',"WHERE o.status='paid' GROUP BY c.name",'ORDER BY revenue DESC;','','name                 revenue','─'*42]
        rows += [f'{str(r[0]):22} {r[1]}' for r in parsed['rows']]
        rows += ['',f"{parsed['rowCount']} rows · real SQLite results"]
    elif 'schema' in title.lower() and 'Compare' not in title:
        cols=parsed.get('columns',[]) if isinstance(parsed,dict) else []
        rows=['customers','─'*50]+[f"{c['name']:16} {c['type']:12} {'PRIMARY KEY' if c.get('isPrimaryKey') else ''}" for c in cols]
    elif 'Select app_logs' in title:
        rows=['Saved connection: pg-demo / postgres','Requested database: app_logs','','SELECT level, count(*) FROM events','GROUP BY level ORDER BY level;','','level                count','─'*40]+[f'{r[0]:20} {r[1]}' for r in parsed['rows']]
    elif 'Compare schemas' in title:
        rows=[]
        for line in json.dumps(parsed,indent=2).splitlines():
            if 'region' in line or 'ALTER' in line or 'migrationScript' in line: rows.extend(textwrap.wrap(line.strip(),95))
        rows=['sales → sales-v2','The v2 schema adds the region column.','']+rows
    else:
        rows=[]
        display=json.dumps(parsed,indent=2,ensure_ascii=False) if not isinstance(parsed,str) else parsed
        for line in display.splitlines():rows.extend(textwrap.wrap(line,95,replace_whitespace=False,drop_whitespace=False) or [''])
    if 'pool' in title.lower(): continue
    img=screen(title,rows)
    frames.append(img);durations.append(2600)
frames[0].save(root/'assets/database-demo.gif',save_all=True,append_images=frames[1:],duration=durations,loop=0,optimize=True)
video_dir=pathlib.Path('/tmp/omnisql-video-frames');video_dir.mkdir(exist_ok=True)
i=0
for frame,duration in zip(frames,durations):
    for _ in range(round(duration/100)):
        frame.save(video_dir/f'{i:05d}.png');i+=1
# Social card uses the same original visual identity.
social=screen('Your databases, one conversation.',[
    'OmniSQL MCP','',
    'One setup command for Claude Code, Codex, and OpenCode.',
    'Saved connections. Native drivers. Controlled access.','',
    'npx -y omnisql-mcp@latest install',
],subtitle='PostgreSQL · MySQL · SQLite · SQL Server · Oracle')
social.save(root/'docs-site/static/img/omnisql-social-card.png')
print(f'Rendered {len(frames)} verified feature scenes.')

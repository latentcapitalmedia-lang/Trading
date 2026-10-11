import io, re, sys

p = r"C:\Users\abuza\Documents\Default Project\chartink-crypto\static\vendor\lightweight-charts.standalone.production.js"
s = io.open(p, encoding="utf-8").read()
print("len", len(s))

pat = sys.argv[1] if len(sys.argv) > 1 else "addPane"
before = int(sys.argv[2]) if len(sys.argv) > 2 else 500
after = int(sys.argv[3]) if len(sys.argv) > 3 else 900

seen = 0
for m in re.finditer(re.escape(pat), s):
    i = m.start()
    print("=== %s @ %d" % (pat, i))
    print(s[max(0, i - before): i + after].replace("\n", " "))
    print()
    seen += 1
    if seen >= 6:
        break
print("occurrences:", len(re.findall(re.escape(pat), s)))

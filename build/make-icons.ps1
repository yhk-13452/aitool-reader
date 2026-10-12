# Derives the icon sizes iOS and the web manifest need from public/pwa-1024.png.
# Pure scaling + maskable safe-zone padding; the artwork itself is untouched.
# Uses .NET System.Drawing so no new dependency is added. ASCII-only on purpose:
# Windows PowerShell 5.1 reads .ps1 as ANSI, so non-ASCII comments break parsing.
Add-Type -AssemblyName System.Drawing

$repoRoot = Split-Path $PSScriptRoot -Parent
$root = Join-Path $repoRoot 'public'
$src = Join-Path $root 'pwa-1024.png'
$img = [System.Drawing.Image]::FromFile($src)

# The source PNG has no alpha channel: the four corners of its canvas are painted
# near-white (251,252,252) instead of transparent. iOS masks the icon anyway, but a
# maskable variant must not carry those wedges, so every output is clipped to the
# artwork's own squircle and the corner area is filled with the icon's background navy.
$navy = [System.Drawing.Color]::FromArgb(255, 26, 26, 46)
$sourceRadiusRatio = 200.0 / 1024.0

function Render([System.Drawing.Image]$source, [int]$size, [string]$out, [double]$factor) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear($navy)
    $inner = [int]($size * $factor)
    $pad = [int](($size - $inner) / 2)
    $r = [int]($inner * $sourceRadiusRatio)
    $d = $r * 2
    # The source has a ~3px near-white margin hugging its own squircle. Drawing the
    # artwork a hair larger than the clip rect pushes that margin outside the clip.
    $bleed = [Math]::Ceiling($size * 0.006)
    $squircle = New-Object System.Drawing.Drawing2D.GraphicsPath
    $squircle.AddArc($pad, $pad, $d, $d, 180, 90)
    $squircle.AddArc($pad + $inner - $d, $pad, $d, $d, 270, 90)
    $squircle.AddArc($pad + $inner - $d, $pad + $inner - $d, $d, $d, 0, 90)
    $squircle.AddArc($pad, $pad + $inner - $d, $d, $d, 90, 90)
    $squircle.CloseFigure()
    $g.SetClip($squircle)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($source, ($pad - $bleed), ($pad - $bleed), ($inner + 2 * $bleed), ($inner + 2 * $bleed))
    $squircle.Dispose()
    $g.Dispose()
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output ("wrote {0} ({1} bytes)" -f (Split-Path $out -Leaf), (Get-Item $out).Length)
}

# factor 1.0 = full bleed; 0.8 = subject stays inside the maskable safe zone.
# 512 is what installers actually pick, so no 1024 maskable: it would just add ~400 KB
# to the precached app shell for a size nothing requests.
Render $img 180 (Join-Path $root 'apple-touch-icon.png') 1.0
Render $img 512 (Join-Path $root 'pwa-512.png') 1.0
Render $img 512 (Join-Path $root 'pwa-512-maskable.png') 0.8
$img.Dispose()

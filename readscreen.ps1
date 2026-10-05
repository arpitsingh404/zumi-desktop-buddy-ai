# Zumi screen reader.
#
# Three modes:
#   -Image <png>     read an existing image file
#   -Hwnd <n>        read one window (needs -Dll): PrintWindow first, screen grab as fallback
#   (neither)        read the whole screen
#
# Recognition uses the OCR engine that ships inside Windows (Windows.Media.Ocr), so there
# is no third-party install, no admin rights and no PATH dependency.
#
# Output (stdout):
#   line 1  ##PNG=<path of the image that was read>
#   line 2  ##RECT=<left,top,right,bottom> | ##RECT=FULL | ##RECT=IMAGE
#   line 3  ##SRC=printwindow | ##SRC=screen | ##SRC=image
#   rest    the recognised text, verbatim (may be empty, may be several lines)
#
# ASCII only - no non-ASCII characters in .ps1 files.

param(
  [string]$Dll   = "",
  [string]$Hwnd  = "",
  [string]$Out   = "",
  [string]$Image = "",
  [int]$Scale    = 0,     # 0 = choose automatically (see the note in step 2)
  [int]$Settle   = 0
)

$ErrorActionPreference = "Stop"
# Loaded FIRST: the window rectangle below is a System.Drawing.Rectangle, and resolving
# that type before the assembly is loaded throws - which the try/catch would swallow and
# quietly degrade the read to the whole screen instead of the window that was asked for.
Add-Type -AssemblyName System.Drawing

$rect = $null
$full = ""
$src  = "screen"

# ---- 1. obtain the pixels ---------------------------------------------
if ($Image -ne "") {
  $src  = "image"
  $full = [System.IO.Path]::GetFullPath($Image)
  if (-not (Test-Path $full)) { throw "image not found: $full" }
} else {
  $done = $false

  # (a) PrintWindow: ask the window for its OWN pixels. Nothing drawn on top can corrupt
  #     the read - which matters because Zumi's own window is always-on-top, and because a
  #     screen grab taken right after a focus can catch a frame that has not repainted yet.
  if ($Hwnd -ne "" -and $Dll -ne "" -and (Test-Path $Dll)) {
    try {
      [Reflection.Assembly]::LoadFrom($Dll) | Out-Null
      $outPath = $Out
      if ($outPath -eq "") { $outPath = Join-Path $env:TEMP ("zumi-ocr-" + [guid]::NewGuid().ToString("N") + ".png") }
      $cap = [ZWin]::Capture([long]$Hwnd, $outPath)
      if ($cap -ne "") {
        $full = $cap
        $src  = "printwindow"
        try {
          $rr = [ZWin]::Rect([long]$Hwnd)
          if ($rr -ne "") {
            $p2 = $rr.Split(',')
            $rect = New-Object System.Drawing.Rectangle `
              ([int]$p2[0]), ([int]$p2[1]), ([int]$p2[2] - [int]$p2[0]), ([int]$p2[3] - [int]$p2[1])
          }
        } catch { }
        $done = $true
      }
    } catch { $done = $false }
  }

  # (b) fallback: grab the screen at that rectangle. Requires the window to be the thing
  #     actually painted there, so give it a moment after being raised. Captured at NATIVE
  #     size - upscaling happens (if at all) in step 2, where it can be chosen to suit the
  #     engine instead of being baked into the pixels.
  if (-not $done) {
    if ($Hwnd -ne "" -and $Dll -ne "" -and (Test-Path $Dll)) {
      try {
        [Reflection.Assembly]::LoadFrom($Dll) | Out-Null
        $r = [ZWin]::Rect([long]$Hwnd)
        if ($r -ne "") {
          $p = $r.Split(',')
          $rect = New-Object System.Drawing.Rectangle `
            ([int]$p[0]), ([int]$p[1]), ([int]$p[2] - [int]$p[0]), ([int]$p[3] - [int]$p[1])
        }
      } catch { $rect = $null }
    }
    if ($null -eq $rect) {
      Add-Type -AssemblyName System.Windows.Forms
      $rect = [System.Windows.Forms.SystemInformation]::VirtualScreen
    }

    if ($Settle -gt 0) { Start-Sleep -Milliseconds $Settle }

    $bmp = New-Object System.Drawing.Bitmap $rect.Width, $rect.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($rect.Location, [System.Drawing.Point]::Empty, $rect.Size)
    $g.Dispose()

    if ($Out -eq "") { $Out = Join-Path $env:TEMP ("zumi-ocr-" + [guid]::NewGuid().ToString("N") + ".png") }
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $full = [System.IO.Path]::GetFullPath($Out)
  }
}

# ---- 2. recognise it with Windows' built-in OCR ------------------------
Add-Type -AssemblyName System.Runtime.WindowsRuntime

# NOTE: this match MUST use single quotes. Written with double quotes, PowerShell treats
# the backtick as its own escape character, silently produces "IAsyncOperation1", finds no
# method, and the [0] below dies with "Cannot index into a null array".
$asTaskGeneric = @([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq "AsTask" -and
  $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
if (-not $asTaskGeneric) { throw "no AsTask helper" }

function AwaitOp([object]$op, [type]$t) {
  $m = $asTaskGeneric.MakeGenericMethod($t)
  $task = $m.Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime]

$engine = $null
try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() } catch { }
if (-not $engine) {
  try {
    $lang = New-Object Windows.Globalization.Language "en-US"
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
  } catch { }
}
if (-not $engine) { throw "no OCR engine available for this profile" }

# Upscaling is NOT a free win for this engine, and it is measurably counter-productive:
# the same Calculator capture read its answer at 1x and at 3x but LOST it at 2x, every
# time (1x: Y/Y/Y, 2x: n/n/n, 3x: Y/Y/Y) - a 2x bicubic pass smears the ClearType
# colour fringes into shapes the engine no longer reads. So: keep native resolution
# whenever the image is already reasonably sized, and only enlarge a genuinely small
# capture, and then use 3x - the enlargement that survived the test.
$scale = $Scale
if ($scale -le 0) {
  $scale = 1
  try {
    $probeImg = [System.Drawing.Image]::FromFile($full)
    $iw = $probeImg.Width
    $probeImg.Dispose()
    $scale = if ($iw -ge 700) { 1 } else { 3 }
  } catch { $scale = 1 }
}

$toRead = $full
if ($scale -gt 1) {
  $bigPath = [System.IO.Path]::ChangeExtension($full, ".ocr.png")
  $srcImg = [System.Drawing.Image]::FromFile($full)
  $w = [int]($srcImg.Width * $scale)
  $h = [int]($srcImg.Height * $scale)
  $big = New-Object System.Drawing.Bitmap $w, $h
  $g3 = [System.Drawing.Graphics]::FromImage($big)
  $g3.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g3.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g3.DrawImage($srcImg, 0, 0, $w, $h)
  $g3.Dispose()
  $srcImg.Dispose()
  $big.Save($bigPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $big.Dispose()
  $toRead = $bigPath
}

$file   = AwaitOp ([Windows.Storage.StorageFile]::GetFileFromPathAsync($toRead)) ([Windows.Storage.StorageFile])
$stream = AwaitOp ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$dec    = AwaitOp ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bmp2   = AwaitOp ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$res    = AwaitOp ($engine.RecognizeAsync($bmp2)) ([Windows.Media.Ocr.OcrResult])

# ---- 3. report ---------------------------------------------------------
"##PNG=" + $toRead
if ($Image -ne "") { "##RECT=IMAGE" }
elseif ($null -eq $rect) { "##RECT=FULL" }
else { "##RECT=" + $rect.X + "," + $rect.Y + "," + $rect.Right + "," + $rect.Bottom }
"##SRC=" + $src
if ($res -and $res.Text) { $res.Text } else { "" }

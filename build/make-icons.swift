// 从一张源图导出主屏 / manifest 用的四个图标。macOS 自带 Swift + CoreGraphics，不引新依赖。
//
//   swift build/make-icons.swift <源图> [输出目录=public]
//   swift build/make-icons.swift                      # 不带参数 = 从 public/pwa-1024.png 重出其余三档
//
// 源图不必是正方形（脚本自己居中裁方），分辨率 ≥1024 即可，更高也只降到 1024。
// 圆角一律不自己画：主屏图标交给 iOS 遮罩，manifest 的 maskable 交给各平台遮罩。
// 不出 1024 的 maskable：安装器只取 512，多一档等于白给预缓存加几百 KB。
import AppKit
import CoreGraphics
import ImageIO
import Foundation

let args = CommandLine.arguments
guard args.count <= 3 else {
    FileHandle.standardError.write("用法: swift build/make-icons.swift [源图] [输出目录=public]\n".data(using: .utf8)!)
    exit(2)
}
let sourcePath = args.count > 1 ? args[1] : "public/pwa-1024.png"
let outDir = args.count > 2 ? args[2] : "public"

guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: sourcePath) as CFURL, nil),
      let raw = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    fatalError("读不到源图: \(sourcePath)")
}
print("源图 \(raw.width)x\(raw.height)")

// 居中裁成正方形：短边不动，长边两侧各去掉一半差值。
let side = min(raw.width, raw.height)
let square = raw.cropping(to: CGRect(x: (raw.width - side) / 2, y: (raw.height - side) / 2, width: side, height: side))!

func canvas(_ size: Int) -> CGContext {
    guard let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpace(name: CGColorSpace.sRGB)!,
                              // noneSkipLast = RGBX，不留 alpha 通道。
                              // 用 .none 建不出来（Quartz 只允许 16bpp 的 .none），带 alpha 的图标
                              // 在 iOS 主屏会被系统垫一层白，所以这里必须是不透明位图。
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
        fatalError("建不了 \(size)x\(size) 位图上下文")
    }
    ctx.interpolationQuality = .high
    return ctx
}

func write(_ ctx: CGContext, _ name: String) {
    guard let img = ctx.makeImage(),
          let dst = CGImageDestinationCreateWithURL(URL(fileURLWithPath: "\(outDir)/\(name)") as CFURL,
                                                    "public.png" as CFString, 1, nil) else {
        fatalError("写不出 \(name)")
    }
    CGImageDestinationAddImage(dst, img, nil)
    guard CGImageDestinationFinalize(dst) else { fatalError("编码失败 \(name)") }
    stripMetadata(URL(fileURLWithPath: "\(outDir)/\(name)"))
    print("→ \(outDir)/\(name)")
}

// ImageIO 写 PNG 会塞一个 eXIf 块（内容是像素尺寸，没有相机/GPS，但它是「这张图由谁生成」的痕迹）。
// 图标是要进公开仓库的素材，一律按块结构剔掉文本与 EXIF 类元数据；颜色管理类（sRGB/pHYs/gAMA/cHRM）留着，
// 那不是隐私，是显示正确性。IDAT 一个字节都不动，所以剔完像素与剔之前逐字相同。
func stripMetadata(_ url: URL) {
    guard let data = try? Data(contentsOf: url), data.count > 8 else { fatalError("读不回 \(url.path)") }
    let bytes = [UInt8](data)
    var out = Array(bytes[0..<8]) // PNG 签名
    var i = 8
    var kept = 0
    let drop: Set<String> = ["eXIf", "tEXt", "zTXt", "iTXt"]
    while i + 12 <= bytes.count {
        let len = (Int(bytes[i]) << 24) | (Int(bytes[i + 1]) << 16) | (Int(bytes[i + 2]) << 8) | Int(bytes[i + 3])
        let type = String(decoding: bytes[(i + 4)..<(i + 8)], as: UTF8.self)
        let end = i + 12 + len
        guard end <= bytes.count else { fatalError("块长度越界（\(type)）\(url.path)") }
        if !drop.contains(type) { out.append(contentsOf: bytes[i..<end]); kept += 1 }
        i = end
    }
    // 走完必须正好停在文件尾，且最后一块是 IEND —— 否则说明我没解析对，宁可炸也不写坏文件
    guard i == bytes.count, String(decoding: out[(out.count - 8)..<(out.count - 4)], as: UTF8.self) == "IEND" else {
        fatalError("PNG 块结构没走完，不敢写回 \(url.path)")
    }
    try! Data(out).write(to: url, options: .atomic)
    print("  元数据剔除：保留 \(kept) 块")
}

// any：铺满整张画布，圆角交给系统遮罩。
func emitAny(_ size: Int, _ name: String) {
    let ctx = canvas(size)
    ctx.draw(square, in: CGRect(x: 0, y: 0, width: size, height: size))
    write(ctx, name)
}

// maskable：主体缩进 80% 安全区。外圈不能补纯色，也不能拿原图拉伸铺底（原图里有一圈大圆装饰，
// 拉伸铺底会露出第二个圆）。改成「边缘抹开」：把缩进后内容的四条边各自向外平铺到画布边，
// 接缝两侧的像素本来就相同，所以必然无缝。
func emitMaskable(_ size: Int, _ name: String) {
    let ctx = canvas(size)
    let inset = Int(round(Double(size) * 0.1))
    let inner = size - inset * 2
    let s = square
    let side = s.width

    ctx.draw(s, in: CGRect(x: inset, y: inset, width: inner, height: inner))
    // 1px 的边条，横向/纵向拉到 inset 宽
    let top = s.cropping(to: CGRect(x: 0, y: 0, width: side, height: 1))!
    let bottom = s.cropping(to: CGRect(x: 0, y: side - 1, width: side, height: 1))!
    let left = s.cropping(to: CGRect(x: 0, y: 0, width: 1, height: side))!
    let right = s.cropping(to: CGRect(x: side - 1, y: 0, width: 1, height: side))!
    // 位图上下文原点在左下，所以 y 要按 size 翻一次
    ctx.draw(top, in: CGRect(x: 0, y: size - inset, width: size, height: inset))
    ctx.draw(bottom, in: CGRect(x: 0, y: 0, width: size, height: inset))
    ctx.draw(left, in: CGRect(x: 0, y: inset, width: inset, height: inner))
    ctx.draw(right, in: CGRect(x: size - inset, y: inset, width: inset, height: inner))
    write(ctx, name)
}

emitAny(1024, "pwa-1024.png")
emitAny(512, "pwa-512.png")
emitAny(180, "apple-touch-icon.png")
emitMaskable(512, "pwa-512-maskable.png")

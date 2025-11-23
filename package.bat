chcp 65001 >nul 2>&1
@echo off
setlocal

rem 定义文件名
set zipFileName=plugin.qwen_mt.zip
set pottextFileName=plugin.qwen_mt.potext

rem 检查并删除已存在的 zip 文件
if exist %zipFileName% (
    del %zipFileName%
    echo 已删除旧的 zip 文件: %zipFileName%
)

rem 检查并删除已存在的 pottext 文件
if exist %pottextFileName% (
    del %pottextFileName%
    echo 已删除旧的 pottext 文件: %pottextFileName%
)

rem 创建 zip 文件
rem 确保当前目录下存在需要打包的文件
if exist qwen-color.svg (
    if exist info.json (
        if exist main.js (
            rem 使用 PowerShell 压缩文件
            powershell -command "Compress-Archive -Path qwen-color.svg, info.json, main.js -DestinationPath %zipFileName%"
            echo 打包完成: %zipFileName%
        ) else (
            echo 文件 main.js 不存在。
            exit /b 1
        )
    ) else (
        echo 文件 info.json 不存在。
        exit /b 1
    )
) else (
    echo 文件 qwen-color.svg 不存在。
    exit /b 1
)

rem 将 zip 文件后缀改为 pottext
ren %zipFileName% %pottextFileName%
echo 文件重命名完成: %pottextFileName%

endlocal

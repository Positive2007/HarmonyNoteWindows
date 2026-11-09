; 云记事 Windows 端安装钩子
; 安装/卸载时本身已提权，在这里直接放行 8787 端口，
; 用户装完就能同步，不必再单独点「防火墙放行.bat」。
; profile=any：手机热点下电脑常被识别为“公用网络”，只放行 private 会连不上。

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "正在放行局域网同步端口 8787..."
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="CloudNote-LAN-8787" dir=in action=allow protocol=TCP localport=8787 profile=any'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DetailPrint "正在移除局域网同步端口规则..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="CloudNote-LAN-8787"'
!macroend

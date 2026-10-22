# Lab phones over Tailscale (no USB) — go-tunnel (Muqraa tooling)

Purpose: run and test go-tunnel (Muqraa tooling) on the two shared lab phones from any machine on Eng. Hassan's tailnet (Windows ZBook, Mac, …), with no cable. Proven 2026-10-22 from the Windows ZBook: wake, launch, screenshot and install over Tailscale on both phones with the USB cable unplugged.

## The phones (real values)

| | Redmi Note 11S | Samsung Galaxy A32 |
|---|---|---|
| Tailscale machine name | `redmi-note-11s` | `a32---senosi` |
| Tailscale IP | `100.104.56.9` | `100.106.162.17` |
| adb over network | `100.104.56.9:5555` | `100.106.162.17:5555` |
| USB serial (when cabled) | `QOPVRGSGIV9T895X` | `RZ8RC0QHX0N` |
| OS | Android 13, Xiaomi HyperOS/MIUI | Android, Samsung One UI |
| SIMs | SIM 1 = Eng. Hassan's personal line · SIM 2 = TtaKkaa company line | no SIM |
| Owner / rules | **Eng. Hassan's personal phone**: no calls, SMS, pairing or account changes without his OK; never touch SIM 1 | shared lab phone |
| Default phone app | SLT Calls (`com.slt.gateway`) — leave it | SLT Calls (`com.slt.gateway`) — leave it |

This app: **``com.slt.muqraa` (moqraa-flutter-app) — scripts in that repo under `scripts/lab-phones/`**.

Also on the tailnet, **not a lab phone — hands off**: Samsung Galaxy Tab A SM-T585, Tailscale `galaxy-tab-a-2016` (`100.110.99.52`), USB serial `5200023a8cf3a641` = the **live SLT Calls gateway, line 015 (WE)**. Never install dev apps on it, never place test calls/SMS; only SLT Calls releases go there. The scripts below only target the two lab phones.

## Use it

| Machine | Command (run from this repo's root) |
|---|---|
| Mac / Linux | `bash scripts/lab-phones/lab-phones.sh connect` then `bash scripts/lab-phones/lab-phones.sh run` |
| Windows | `.\scripts\lab-phones\LabPhones.ps1 connect` then `.\scripts\lab-phones\LabPhones.ps1 run` |

- `connect` finds both phones by Tailscale name and runs `adb connect <ip>:5555`.
- `run` = `flutter build apk --debug`, Xiaomi-safe install on every connected phone, launch ``com.slt.muqraa` (moqraa-flutter-app) — scripts in that repo under `scripts/lab-phones/`.
- `install <apk> [serial]` installs any APK; `shot <serial>` saves a screenshot.
- `flutter run -d 100.106.162.17:5555` also works for hot reload on the A32. On the Redmi prefer `run` (HyperOS can cancel Flutter's own install).

Requirements on the machine: Tailscale signed in to Eng. Hassan's tailnet (`hassangomaa974@`), Android platform-tools (`adb`), Flutter. Mac paths the script uses by default: `/Applications/Tailscale.app/Contents/MacOS/Tailscale` and `~/Library/Android/sdk/platform-tools/adb` (override with `TAILSCALE=` / `ADB=`).

## Rules (house rules, same as SLT Calls / TtaKkaa / EgyGuests)

1. **Install only through these scripts** (or the ecosystem `scripts/android/Adb-Install.ps1`). A plain `adb install` is silently cancelled on Xiaomi/HyperOS.
2. No real calls or SMS from the lab phones unless Eng. Hassan asks (testing brake).
3. Keep Tailscale ON on both phones; keep SLT Calls as the default phone app; don't sign out of Google on the phones.

## When it stops working

| Symptom | Fix |
|---|---|
| `connect` says "no adb" after a phone restart | adb TCP mode resets on reboot. Either plug USB once and run `adb tcpip 5555`, or on the phone: Developer options › Wireless debugging › Pair device with pairing code, then `adb pair 100.x.y.z:<pair-port> <code>` and `adb connect 100.x.y.z:<port>` |
| "not in the tailnet" | Open the Tailscale app on the phone and switch the VPN on |
| Install "canceled by user" on the Redmi | Developer options › "Install via USB" must be ON (the script sets the related globals; this one toggle may need a tap) |
| A new phone (unknown key) | The phone shows "Allow USB debugging?" — accept it once on the phone |

Security: adb only accepts machines whose key the phone has already authorised; Tailscale keeps the port off the internet. On a shared Wi-Fi, switch a phone back to USB-only with `adb -s <serial> usb`.

Source of truth for the phones: `Smart-Lead-Tech/slt-calls-ecosystem` → `docs/runbooks/device-testing.md` and `ops/android/Connect-Phones.ps1`.

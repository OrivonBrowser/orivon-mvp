// What `scutil --proxy` printed on a GitHub-hosted macOS runner (macOS 26) in each state `networksetup` was asked to leave it in, as the program prints it:
// the keys come in this order, a switch that is off still has its line, and a server that is off has no host or port.

/** A runner with no proxy set: the exceptions macOS ships and nothing else. */
export const NO_PROXY = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
}
`

/** `networksetup -setwebproxy` and `-setsecurewebproxy` to the same server. */
export const HTTP_AND_HTTPS = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 18082
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 18082
  HTTPSProxy : 127.0.0.1
}
`

/** Only the web proxy on. */
export const HTTP_ONLY = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 18080
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 0
  ProxyAutoDiscoveryEnable : 0
  SOCKSEnable : 0
}
`

/** Both turned off again with `-setwebproxystate off`: the server and port keys are gone. */
export const TURNED_OFF = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
  HTTPEnable : 0
  HTTPSEnable : 0
}
`

/** `-setftpproxy` alone: `scutil --proxy` prints no line for an FTP proxy, so only the switches that are off remain. */
export const ALL_OFF = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
  HTTPEnable : 0
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 0
  ProxyAutoDiscoveryEnable : 0
  SOCKSEnable : 0
}
`

/** `-setsocksfirewallproxy` alone. */
export const SOCKS_ONLY = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
  HTTPEnable : 0
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 0
  ProxyAutoDiscoveryEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 11080
  SOCKSProxy : 127.0.0.1
}
`

/** Three servers, the HTTPS one at another address. */
export const HTTP_HTTPS_SOCKS = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 18080
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 18443
  HTTPSProxy : 127.0.0.2
  ProxyAutoConfigEnable : 0
  ProxyAutoDiscoveryEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 11080
  SOCKSProxy : 127.0.0.1
}
`

/** `-setautoproxyurl` alone. */
export const SCRIPT_ONLY = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
  HTTPEnable : 0
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://127.0.0.1:49219/p.pac
  ProxyAutoDiscoveryEnable : 0
  SOCKSEnable : 0
}
`

/** A script and a web proxy on together. */
export const SCRIPT_AND_MANUAL = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 18080
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://127.0.0.1:49219/p.pac
  ProxyAutoDiscoveryEnable : 0
  SOCKSEnable : 0
}
`

/** The same, the script turned off again. */
export const SCRIPT_OFF_MANUAL = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 18080
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 0
  ProxyAutoDiscoveryEnable : 0
  SOCKSEnable : 0
}
`

/** `-setproxyautodiscovery on` alone: macOS also turns its script on, at a fixed address. */
export const DISCOVERY_ONLY = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
  HTTPEnable : 0
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://wpad/wpad.dat
  ProxyAutoDiscoveryEnable : 1
  SOCKSEnable : 0
}
`

/** Discovery on beside web and secure web proxies. */
export const DISCOVERY_AND_MANUAL = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 18080
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 18080
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://wpad/wpad.dat
  ProxyAutoDiscoveryEnable : 1
  SOCKSEnable : 0
}
`

/** Fourteen exceptions of every kind `networksetup -setproxybypassdomains` took, the last with spaces round it. */
export const ODD_EXCEPTIONS = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.corp.test
    1 : .dot.test
    2 : bare.test
    3 : 10.0.0.0/8
    4 : a.test:8080
    5 : ::1
    6 : fe80::/10
    7 : http://scheme.test
    8 : <local>
    9 : two words
    10 : semi;colon
    11 : comma,sep
    12 : *.UPPER.test
    13 :  padded.test${' '}
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 18080
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 18080
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  ProxyAutoDiscoveryEnable : 0
  SOCKSEnable : 0
}
`

/** Exceptions that hold a space, a semicolon and a comma. */
export const SEPARATORS = `<dictionary> {
  ExceptionsList : <array> {
    0 : foo.test bar.test
    1 : semi.test;colon.test
    2 : comma.test,sep.test
    3 : ok.test
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 18080
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 18080
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  ProxyAutoDiscoveryEnable : 0
  SOCKSEnable : 0
}
`

/** A server named by host name. */
export const NAMED_SERVER = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 3128
  HTTPProxy : proxy.example.test
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 0
  ProxyAutoDiscoveryEnable : 0
  SOCKSEnable : 0
}
`

/** A server at an IPv6 address. */
export const IPV6_SERVER = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 3128
  HTTPProxy : 2001:db8::1
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 0
  ProxyAutoDiscoveryEnable : 0
  SOCKSEnable : 0
}
`

/** "Exclude simple hostnames" ticked in the Proxies pane. */
export const SIMPLE_HOSTNAMES_EXCLUDED = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  ExcludeSimpleHostnames : 1
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 18080
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 18080
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  ProxyAutoDiscoveryEnable : 0
  SOCKSEnable : 0
}
`

/** `show State:/Network/Global/Proxies` in scutil: the switches off with the old servers still stored, and each interface's own copy below `__SCOPED__`. */
export const STORE_WITH_INTERFACES = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
  HTTPEnable : 0
  HTTPPort : 18080
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 0
  HTTPSPort : 18080
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  ProxyAutoConfigURLString : http://127.0.0.1:49219/p.pac
  ProxyAutoDiscoveryEnable : 0
  SOCKSEnable : 0
  SOCKSPort : 11080
  SOCKSProxy : 127.0.0.1
  __SCOPED__ : <dictionary> {
    en0 : <dictionary> {
      ExceptionsList : <array> {
        0 : *.local
        1 : 169.254/16
      }
      FTPPassive : 1
      HTTPEnable : 0
      HTTPPort : 18080
      HTTPProxy : 127.0.0.1
      HTTPSEnable : 0
      HTTPSPort : 18080
      HTTPSProxy : 127.0.0.1
      ProxyAutoConfigEnable : 0
      ProxyAutoConfigURLString : http://127.0.0.1:49219/p.pac
      ProxyAutoDiscoveryEnable : 0
      SOCKSEnable : 0
      SOCKSPort : 11080
      SOCKSProxy : 127.0.0.1
    }
  }
}
`

/** `-setproxybypassdomains Empty`: no `ExceptionsList` key at all. */
export const NO_EXCEPTIONS = `<dictionary> {
  FTPPassive : 1
  HTTPEnable : 0
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 0
  ProxyAutoDiscoveryEnable : 0
  SOCKSEnable : 0
}
`

/** A web and secure web proxy with no exceptions. */
export const MANUAL_NO_EXCEPTIONS = `<dictionary> {
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 18080
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 18080
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  ProxyAutoDiscoveryEnable : 0
  SOCKSEnable : 0
}
`

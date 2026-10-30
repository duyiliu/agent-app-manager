package dev.projectrunner.demo;

import java.time.Instant;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api")
public class DemoController {
    private static final Logger log = LoggerFactory.getLogger(DemoController.class);

    @GetMapping("/health")
    public Map<String, Object> health() {
        return Map.of("status", "UP", "application", "agent-app-manager-demo",
                "pid", ProcessHandle.current().pid(), "time", Instant.now().toString());
    }

    @GetMapping("/hello")
    public Map<String, String> hello(@RequestParam(defaultValue = "Agent App Manager") String name) {
        return Map.of("message", "Hello, " + name + "!", "version", "v2");
    }

    @PostMapping("/logs")
    public Map<String, String> logs(@RequestParam(defaultValue = "INFO") String level) {
        switch (level) {
            case "INFO" -> log.info("Demo log: INFO sample");
            case "WARN" -> log.warn("Demo log: WARN sample");
            case "ERROR" -> log.error("Demo log: ERROR sample (intentional)",
                    new IllegalStateException("Intentional demo exception; application stays healthy"));
            default -> throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "level must be INFO, WARN or ERROR");
        }
        return Map.of("logged", level);
    }
}
